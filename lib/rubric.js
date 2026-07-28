// Shared scoring logic for the Anchour voice checker.
//
// One source of truth used by both the serverless function (api/check.js) and
// the CLI runner (scripts/score.mjs): it loads the rubric + samples, builds the
// grounded system prompt, defines the structured-output schema, calls Claude,
// and computes the overall score / pass verdict deterministically in code.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MODEL = "claude-sonnet-5";

// The six rubric dimensions, in rubric order. The names must match the
// headings in voice-rubric.md exactly — they're the enum the model scores
// against and the order we validate the response in.
export const DIMENSIONS = [
  "Sentence Rhythm & Economy",
  "Concrete Over Abstract",
  "Conviction & Stance",
  "Substance Over Hype",
  "Warmth With a Moral Center",
  "Partner Voice (We + You)",
];

// Pass bar, straight from voice-rubric.md: >= 4 average AND no dimension < 3.
const PASS_AVG = 4;
const PASS_FLOOR = 3;

// Resolve a project file whether we're running from the repo root (CLI) or a
// bundled serverless function (module-relative). Try both, prefer whichever
// exists.
function resolveProjectFile(name) {
  const candidates = [
    path.join(HERE, "..", name), // module-relative (…/lib/../name)
    path.join(process.cwd(), name), // cwd-relative (repo root)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fall back to the module-relative path so the error message is meaningful.
  return candidates[0];
}

// Read grounding material once at module load (reused across warm invocations).
const RUBRIC = fs.readFileSync(resolveProjectFile("voice-rubric.md"), "utf8").trim();
const SAMPLES_RAW = fs.readFileSync(resolveProjectFile("voice-samples.txt"), "utf8");

// Pull 3–4 real excerpts from voice-samples.txt: split on the `---` dividers,
// drop the header note, and take the first four passages of actual copy.
function loadExcerpts() {
  return SAMPLES_RAW.split(/\n-{3,}\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^Anchour — Website Voice Samples/i.test(p))
    .slice(0, 4);
}

const EXCERPTS = loadExcerpts();

export function buildSystemPrompt() {
  const excerptBlock = EXCERPTS.map((e) => `- "${e.replace(/\s+/g, " ")}"`).join("\n");

  return `You are a brand voice consistency checker for Anchour, a creative agency.

Your job is to score a piece of copy STRICTLY against the rubric below — not
against generic brand-voice knowledge. Every score must be justified by the
rubric's dimensions and the target voice shown in the real Anchour copy. Judge
only the voice, not the factual accuracy or the marketing strategy.

=== ANCHOUR VOICE RUBRIC ===
${RUBRIC}

=== REFERENCE: REAL ANCHOUR COPY (this is the target voice) ===
${excerptBlock}

=== HOW TO RESPOND ===
Score the copy the user provides on each of the six dimensions, using that
dimension's "How to score" note as your guide:
- score: an integer from 1 to 5 (5 = textbook Anchour, 3 = neutral, 1 = actively off-voice).
- reasoning: ONE concise sentence naming the specific feature of the text that drove the score (quote a phrase where useful).

Then write 1–2 rewrite suggestions: the user's copy rewritten in Anchour's
voice, preserving its meaning and intent. Each rewrite should be a concrete,
usable line — not advice about how to rewrite.

Return the six dimensions in the rubric's order, each exactly once. Respond
with the structured JSON only.`;
}

// Structured-output schema (output_config.format). Constraints follow the
// documented structured-output limits: additionalProperties:false everywhere,
// enums instead of min/max. Overall score and pass are computed in code, not
// requested from the model, so the arithmetic and the pass rule are exact.
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimensions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", enum: DIMENSIONS },
          score: { type: "integer", enum: [1, 2, 3, 4, 5] },
          reasoning: { type: "string" },
        },
        required: ["name", "score", "reasoning"],
      },
    },
    rewrites: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["dimensions", "rewrites"],
};

// Extract the JSON payload from a Messages response, tolerating the model
// wrapping it in prose or a ```json fence if structured output isn't applied.
function parseModelJson(response) {
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse JSON from model response: ${text.slice(0, 300)}`);
  }
}

// Order dimensions per the rubric and verify all six are present exactly once.
function normalizeDimensions(dimensions) {
  if (!Array.isArray(dimensions)) {
    throw new Error("Model response missing a 'dimensions' array.");
  }
  const byName = new Map(dimensions.map((d) => [d.name, d]));
  return DIMENSIONS.map((name) => {
    const d = byName.get(name);
    if (!d) throw new Error(`Model response missing dimension: ${name}`);
    return { name, score: d.score, reasoning: d.reasoning };
  });
}

// Deterministic overall score + pass verdict, straight from the rubric's rule.
export function computeSummary(dimensions) {
  const scores = dimensions.map((d) => d.score);
  const overall = scores.reduce((a, b) => a + b, 0) / scores.length;
  const overall_score = Math.round(overall * 10) / 10;
  const pass = overall_score >= PASS_AVG && Math.min(...scores) >= PASS_FLOOR;
  return { overall_score, pass };
}

// Score a piece of copy. `client` is an initialized Anthropic SDK client.
export async function scoreText(client, text) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: RESPONSE_SCHEMA },
    },
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: `Score this copy against the Anchour voice rubric:\n\n"""\n${text}\n"""`,
      },
    ],
  });

  const parsed = parseModelJson(response);
  const dimensions = normalizeDimensions(parsed.dimensions);
  const rewrites = Array.isArray(parsed.rewrites) ? parsed.rewrites.slice(0, 2) : [];
  const { overall_score, pass } = computeSummary(dimensions);

  return { overall_score, pass, dimensions, rewrites, model: response.model };
}

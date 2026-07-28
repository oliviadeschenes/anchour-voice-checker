// Shared scoring logic for the Anchour voice checker.
//
// One source of truth used by both the serverless function (api/check.js) and
// the CLI runner (scripts/score.mjs): it loads the rubric + samples, builds the
// grounded system prompt, asks Claude for a fixed-shape JSON result, and
// computes the overall score / pass verdict deterministically in code.
//
// Note: the model is asked for stable slug keys (not long dimension names), and
// the result is mapped back with normalization-tolerant matching. This avoids
// depending on the model echoing exact title-case names or on structured-output
// enum enforcement (which the pinned SDK version does not support).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MODEL = "claude-sonnet-5";

// The six rubric dimensions, in rubric order. `key` is the stable slug the model
// fills in; `name` is the display name (must match the heading in voice-rubric.md).
export const DIMENSIONS = [
  { key: "sentence_rhythm", name: "Sentence Rhythm & Economy" },
  { key: "concrete_over_abstract", name: "Concrete Over Abstract" },
  { key: "conviction_stance", name: "Conviction & Stance" },
  { key: "substance_over_hype", name: "Substance Over Hype" },
  { key: "warmth_moral_center", name: "Warmth With a Moral Center" },
  { key: "partner_voice", name: "Partner Voice (We + You)" },
];

// Pass bar, straight from voice-rubric.md: >= 4 average AND no dimension < 3.
const PASS_AVG = 4;
const PASS_FLOOR = 3;

// Resolve a project file whether we're running from the repo root (CLI) or a
// bundled serverless function (module-relative). Prefer whichever exists.
function resolveProjectFile(name) {
  const candidates = [path.join(HERE, "..", name), path.join(process.cwd(), name)];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

// Read grounding material once at module load (reused across warm invocations).
const RUBRIC = fs.readFileSync(resolveProjectFile("voice-rubric.md"), "utf8").trim();
const SAMPLES_RAW = fs.readFileSync(resolveProjectFile("voice-samples.txt"), "utf8");

// Pull 3–4 real excerpts from voice-samples.txt: split on the `---` dividers,
// drop the header note, and take the first four passages of actual copy.
const EXCERPTS = SAMPLES_RAW.split(/\n-{3,}\n/)
  .map((p) => p.trim())
  .filter((p) => p && !/^Anchour — Website Voice Samples/i.test(p))
  .slice(0, 4);

// Normalize a key or name for tolerant matching: lowercase, strip everything
// that isn't a letter or digit. "Concrete Over Abstract" and
// "concrete_over_abstract" both become "concreteoverabstract".
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildSystemPrompt() {
  const excerptBlock = EXCERPTS.map((e) => `- "${e.replace(/\s+/g, " ")}"`).join("\n");
  const legend = DIMENSIONS.map((d, i) => `- ${d.key} → ${i + 1}. ${d.name}`).join("\n");
  const template = DIMENSIONS.map(
    (d) => `    "${d.key}": { "score": <1-5 integer>, "reasoning": "<one sentence>" }`,
  ).join(",\n");

  return `You are a brand voice consistency checker for Anchour, a creative agency.

Your job is to score a piece of copy STRICTLY against the rubric below — not
against generic brand-voice knowledge. Every score must be justified by the
rubric's dimensions and the target voice shown in the real Anchour copy. Judge
only the voice, not the factual accuracy or the marketing strategy.

=== ANCHOUR VOICE RUBRIC ===
${RUBRIC}

=== REFERENCE: REAL ANCHOUR COPY (this is the target voice) ===
${excerptBlock}

=== HOW TO SCORE ===
Score the copy on each of the six dimensions, using that dimension's
"How to score" note as your guide:
- score: an integer 1–5 (5 = textbook Anchour, 3 = neutral, 1 = actively off-voice).
- reasoning: ONE concise sentence naming the specific feature of the text that
  drove the score (quote a phrase where useful).

Each JSON key maps to a rubric dimension:
${legend}

Then write 1–2 rewrites: the user's copy rewritten in Anchour's voice,
preserving its meaning and intent. Each rewrite is a concrete, usable line —
not advice about how to rewrite.

=== OUTPUT ===
Respond with ONLY a JSON object of exactly this shape — every key present, no
extra keys, no prose or code fences around it:

{
  "scores": {
${template}
  },
  "rewrites": ["<in-voice rewrite>", "<optional second rewrite>"]
}`;
}

// Retained for documentation / a future SDK upgrade that supports
// output_config.format (structured outputs). Not sent by the pinned SDK.
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        DIMENSIONS.map((d) => [
          d.key,
          {
            type: "object",
            additionalProperties: false,
            properties: {
              score: { type: "integer", enum: [1, 2, 3, 4, 5] },
              reasoning: { type: "string" },
            },
            required: ["score", "reasoning"],
          },
        ]),
      ),
      required: DIMENSIONS.map((d) => d.key),
    },
    rewrites: { type: "array", items: { type: "string" } },
  },
  required: ["scores", "rewrites"],
};

// Extract the JSON payload from a Messages response, tolerating the model
// wrapping it in prose or a ```json fence.
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

// Build a normalized lookup from whatever score container the model returned —
// works for `{scores: {...}}`, a top-level object, or a `dimensions: [...]`
// array, keyed by either slug or display name, in any casing/punctuation.
function buildScoreLookup(parsed) {
  const lut = new Map();
  const add = (rawKey, value) => {
    if (rawKey != null && value && typeof value === "object") lut.set(norm(rawKey), value);
  };

  const container =
    parsed.scores && typeof parsed.scores === "object" ? parsed.scores : parsed;
  if (container && typeof container === "object" && !Array.isArray(container)) {
    for (const [k, v] of Object.entries(container)) add(k, v);
  }
  if (Array.isArray(parsed.dimensions)) {
    for (const d of parsed.dimensions) add(d?.key ?? d?.name, d);
  }
  return lut;
}

function coerceScore(raw, name) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) throw new Error(`Invalid score for dimension: ${name}`);
  return Math.min(5, Math.max(1, n));
}

// Map the model's scores onto the six rubric dimensions, in rubric order.
function normalizeDimensions(parsed) {
  const lut = buildScoreLookup(parsed);
  return DIMENSIONS.map(({ key, name }) => {
    const entry = lut.get(norm(key)) ?? lut.get(norm(name));
    if (!entry) throw new Error(`Model response missing dimension: ${name}`);
    return {
      name,
      score: coerceScore(entry.score, name),
      reasoning: String(entry.reasoning ?? "").trim(),
    };
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
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: `Score this copy against the Anchour voice rubric:\n\n"""\n${text}\n"""`,
      },
    ],
  });

  const parsed = parseModelJson(response);
  const dimensions = normalizeDimensions(parsed);
  const rewrites = Array.isArray(parsed.rewrites)
    ? parsed.rewrites.map((r) => String(r).trim()).filter(Boolean).slice(0, 2)
    : [];
  const { overall_score, pass } = computeSummary(dimensions);

  return { overall_score, pass, dimensions, rewrites, model: response.model };
}

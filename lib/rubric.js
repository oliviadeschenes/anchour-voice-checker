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
// Computed over APPLICABLE dimensions only (see the N/A gate below).
const PASS_AVG = 4;
const PASS_FLOOR = 3;

// --- N/A gate ---------------------------------------------------------------
// A dimension may be marked not-applicable when the copy is a short headline
// that structurally can't exhibit it. The model only *proposes* N/A; the server
// decides. N/A is honored only if ALL of these hold, so it can't be used as an
// escape hatch to dodge a low score:
//   - the dimension is one of the two eligible dimensions, and
//   - the copy is at most NA_MAX_WORDS words, and
//   - the model's own score is >= NA_MIN_SCORE (a 1-2 means active violation,
//     which means the dimension applies — even via vocabulary we didn't list), and
//   - the dimension-specific marker gate passes.
const NA_ELIGIBLE = new Set(["partner_voice", "warmth_moral_center"]);
const NA_MAX_WORDS = 12;
const NA_MIN_SCORE = 3;

// First/second-person pronouns — presence means Partner Voice IS engaged.
const PRONOUN =
  /\b(?:i|me|my|mine|myself|we|us|our|ours|ourselves|let's|you|your|yours|yourself|yourselves)\b/i;
// Detached third-person self-reference — presence means the dimension is being
// worked against (cold / describing the agency from outside), not merely absent.
const SELF_REF =
  /\b(?:the\s+(?:company|agency|team|firm|brand|studio|organi[sz]ation)|clients?|customers?|businesses)\b/i;
// Hype / aggression / transactional vocabulary — presence means Warmth or
// Substance is being actively worked against.
const ANTI_WARMTH =
  /\b(?:leverage|synerg\w*|optimi[sz]e\w*|maximi[sz]e\w*|dominat\w*|aggressive|roi|best-in-class|world-class|cutting-edge|game-chang\w*|disrupt\w*|monetiz\w*|shareholder|kpis?)\b/i;

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

// Whether an `applicable: false` proposed by the model should be honored.
function naGatePasses(key, text, score) {
  if (!NA_ELIGIBLE.has(key)) return false;
  if (wordCount(text) > NA_MAX_WORDS) return false;
  if (score < NA_MIN_SCORE) return false;
  if (SELF_REF.test(text)) return false; // detached framing → dimension applies
  if (key === "partner_voice") return !PRONOUN.test(text);
  if (key === "warmth_moral_center") return !ANTI_WARMTH.test(text);
  return false;
}

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
    (d) =>
      `    "${d.key}": { "score": <1-5 integer>, "reasoning": "<one sentence>", "applicable": true }`,
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
"How to score" note as your guide. Apply this scale the SAME WAY to every
dimension:
- 5 — strongly and distinctively exhibits the dimension (textbook Anchour).
- 4 — clearly exhibits it.
- 3 — NEUTRAL: mixed signals, OR the copy simply doesn't engage this pattern
      without working against it. Absence is neutral, never a failure.
- 2 — leans against the dimension.
- 1 — actively works against the dimension (off-voice).

CRITICAL — distinguish "doesn't use this pattern" from "works against it".
Short or narrow copy (a headline, a tagline) often can't exhibit every
dimension, and that is fine. Judge what the copy DOES, not what it omits:
- If the copy does not use a dimension's pattern but does nothing against it,
  score it 3 — not 1 or 2.
- Reserve 1–2 for copy that actively pulls the other way, e.g.:
  • Partner Voice: 1–2 only for detached third-person ("the company", "clients",
    "businesses") or the agency described from the outside. A line with no
    "we"/"you" is 3, not low.
  • Warmth With a Moral Center: 1–2 only for cold, transactional, or aggressive
    framing. Copy merely silent on warmth is 3.
  • Substance Over Hype: 1–2 only for real hype or empty superlatives. Plain,
    modest copy with no hype is not a hype failure.

=== WHEN A DIMENSION DOESN'T APPLY ===
"applicable" is almost always true. Set it to false ONLY when the copy is a
short headline or tagline that structurally cannot exhibit the dimension, and
ONLY for Partner Voice or Warmth With a Moral Center. For the other four
dimensions, always use true. Never use false to avoid giving a low score — if
the copy works AGAINST a dimension, that is a low score (1–2), not N/A. Even
when you set "applicable": false, still fill in your best-guess "score". The
server independently re-checks every "applicable": false and overrides it to
true unless the copy genuinely qualifies.

- score: an integer 1–5 as defined above.
- reasoning: ONE concise sentence naming the specific feature of the text that
  drove the score (quote a phrase where useful). When you score 3 for absence,
  say so briefly (e.g. "no 'we'/'you', but nothing detached either").
- applicable: true, except the narrow headline case described above.

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
              applicable: { type: "boolean" },
            },
            required: ["score", "reasoning", "applicable"],
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

// Map the model's scores onto the six rubric dimensions, in rubric order, and
// resolve each dimension's applicability through the server-side N/A gate.
function normalizeDimensions(parsed, text) {
  const lut = buildScoreLookup(parsed);
  return DIMENSIONS.map(({ key, name }) => {
    const entry = lut.get(norm(key)) ?? lut.get(norm(name));
    if (!entry) throw new Error(`Model response missing dimension: ${name}`);
    const score = coerceScore(entry.score, name);
    const wantsNA = entry.applicable === false;
    const applicable = !(wantsNA && naGatePasses(key, text, score));
    return { name, score, reasoning: String(entry.reasoning ?? "").trim(), applicable };
  });
}

// Deterministic overall score + pass verdict over the APPLICABLE dimensions.
export function computeSummary(dimensions) {
  const active = dimensions.filter((d) => d.applicable !== false);
  const pool = active.length ? active : dimensions; // guard against divide-by-zero
  const scores = pool.map((d) => d.score);
  const overall = scores.reduce((a, b) => a + b, 0) / scores.length;
  const overall_score = Math.round(overall * 10) / 10;
  const pass = overall_score >= PASS_AVG && Math.min(...scores) >= PASS_FLOOR;
  return { overall_score, pass, applicable_count: scores.length };
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
  const dimensions = normalizeDimensions(parsed, text);
  const rewrites = Array.isArray(parsed.rewrites)
    ? parsed.rewrites.map((r) => String(r).trim()).filter(Boolean).slice(0, 2)
    : [];
  const { overall_score, pass, applicable_count } = computeSummary(dimensions);

  return { overall_score, pass, applicable_count, dimensions, rewrites, model: response.model };
}

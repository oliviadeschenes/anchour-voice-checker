// Step 3 live test: POST three fixtures (on-voice / off-voice / borderline) to a
// deployed /api/check endpoint and print the raw JSON, so we can tune the prompt.
//
//   node scripts/live-test.mjs https://<your-deployment>.vercel.app
//   VOICE_CHECKER_URL=https://<your-deployment>.vercel.app node scripts/live-test.mjs
//
// Runs anywhere with network access to the deployment (Node 18+ for global fetch).
// No API key needed here — the key lives server-side in the deployment.

const base = process.argv[2] || process.env.VOICE_CHECKER_URL;
if (!base) {
  console.error("Usage: node scripts/live-test.mjs <deployment-base-url>");
  process.exit(1);
}
const endpoint = base.replace(/\/+$/, "") + "/api/check";

const cases = [
  [
    "ON-VOICE (real Anchour line, not in the grounding excerpts)",
    "Building brands with purpose, scale, and staying power.",
  ],
  [
    "OFF-VOICE (generic corporate)",
    "We leverage synergistic, data-driven solutions to optimize your brand's holistic potential and deliver best-in-class results across every vertical.",
  ],
  [
    "BORDERLINE (warm-ish but generic and hedged)",
    "We're a full-service agency that helps businesses grow. Our team is passionate about delivering results and building lasting partnerships with our clients.",
  ],
];

console.log(`Endpoint: ${endpoint}\n`);
for (const [label, text] of cases) {
  console.log(`=== ${label} ===`);
  console.log(`Input: ${text}`);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const raw = await res.text();
    console.log(`HTTP ${res.status}`);
    try {
      console.log(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      console.log(raw.slice(0, 800));
    }
  } catch (err) {
    console.error(`Request failed: ${err.message}`);
  }
  console.log();
}

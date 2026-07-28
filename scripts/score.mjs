// Step 2/3 CLI: score a piece of copy against the rubric from the command line,
// so we can tune the prompt before building any UI.
//
//   node scripts/score.mjs "Your copy here"
//   node scripts/score.mjs --file path/to/copy.txt
//   echo "Your copy" | node scripts/score.mjs
//
// Reads ANTHROPIC_API_KEY from the environment (or .env.local if present).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { scoreText } from "../lib/rubric.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function bar(score) {
  return "█".repeat(score) + "░".repeat(5 - score);
}

async function main() {
  loadEnvLocal();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set.\n" +
        "Set it in the environment, or copy .env.example to .env.local and add the key.",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let text = "";
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    text = fs.readFileSync(args[fileIdx + 1], "utf8");
  } else if (args.length > 0) {
    text = args.join(" ");
  } else {
    text = await readStdin();
  }

  text = text.trim();
  if (!text) {
    console.error('No input. Pass copy as an argument, --file <path>, or via stdin.');
    process.exit(1);
  }

  const client = new Anthropic();
  const result = await scoreText(client, text);

  // Human-readable summary...
  console.log(`\nInput: ${JSON.stringify(text.slice(0, 120))}${text.length > 120 ? "…" : ""}`);
  console.log(
    `\nOverall: ${result.overall_score}/5   ${result.pass ? "PASS ✅" : "FAIL ❌"}   (model: ${result.model})\n`,
  );
  for (const d of result.dimensions) {
    console.log(`  ${bar(d.score)} ${d.score}  ${d.name}`);
    console.log(`         ${d.reasoning}\n`);
  }
  console.log("  Rewrites:");
  result.rewrites.forEach((r, i) => console.log(`   ${i + 1}. ${r}`));

  // ...and the raw JSON the frontend will consume.
  console.log("\n--- raw JSON ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Error:", err?.message ?? err);
  process.exit(1);
});

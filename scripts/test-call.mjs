// Step 1: hardcoded test call to confirm the Claude API connection and
// server-side key handling work — BEFORE any prompt logic or UI.
//
//   node scripts/test-call.mjs
//
// Reads ANTHROPIC_API_KEY from the environment (or from .env.local if present).
// The key stays server-side; nothing here ever runs in a browser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env.local loader so a key dropped in that file "just works"
// locally, without adding a dotenv dependency.
function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

loadEnvLocal();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set.\n" +
      "Set it in the environment, or copy .env.example to .env.local and add the key.",
  );
  process.exit(1);
}

const MODEL = "claude-sonnet-5";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const response = await client.messages.create({
  model: MODEL,
  max_tokens: 64,
  thinking: { type: "disabled" }, // trivial connectivity probe — no need to think
  messages: [
    {
      role: "user",
      content: "Reply with exactly: Anchour voice checker API connection OK",
    },
  ],
});

const text = response.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("");

console.log("Model:", response.model);
console.log("Reply:", text.trim());
console.log("Usage:", JSON.stringify(response.usage));

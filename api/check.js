// Vercel serverless function — POST /api/check
//
// Body:    { "text": "<copy to score>" }
// Returns: { overall_score, pass, dimensions: [{name, score, reasoning}], rewrites: [] }
//
// The Claude API key is read from process.env.ANTHROPIC_API_KEY inside this
// function only. The browser calls this endpoint; this endpoint calls Claude.
// The key is never exposed to the client or bundled into client-side code.

import Anthropic from "@anthropic-ai/sdk";
import { scoreText } from "../lib/rubric.js";

const MAX_INPUT_CHARS = 8000;

// Vercel usually parses JSON bodies, but fall back to reading the raw stream so
// the function is robust regardless of how it's invoked.
async function readBody(req) {
  if (req.body != null) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  let text;
  try {
    ({ text } = await readBody(req));
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Provide a non-empty 'text' field to score." });
  }
  if (text.length > MAX_INPUT_CHARS) {
    return res
      .status(400)
      .json({ error: `Text is too long (max ${MAX_INPUT_CHARS} characters).` });
  }

  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const result = await scoreText(client, text.trim());
    return res.status(200).json(result);
  } catch (err) {
    console.error("check.js error:", err);
    const status = err?.status ?? 500;
    return res.status(status).json({ error: err?.message ?? "Failed to score text." });
  }
}

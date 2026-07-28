// Vercel serverless function — /api/check
//
// STEP 1 (current): a hardcoded test call, to prove the function can reach
// the Claude API and that the API key is read securely server-side. The real
// rubric-grounded scoring prompt + structured JSON output land in step 2.
//
// The API key is read from process.env.ANTHROPIC_API_KEY inside this function
// only. It is never sent to the browser and never bundled into client code —
// the browser calls this endpoint, this endpoint calls Claude.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

    // Hardcoded probe for step 1. Replaced by real scoring logic in step 2.
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 64,
      thinking: { type: "disabled" },
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
      .join("")
      .trim();

    return res.status(200).json({ ok: true, model: response.model, reply: text });
  } catch (err) {
    console.error("check.js error:", err);
    const status = err?.status ?? 500;
    return res
      .status(status)
      .json({ error: err?.message ?? "Unexpected error calling Claude." });
  }
}

# Anchour Voice Checker

A small, deployable web app that scores a piece of copy against Anchour's
brand voice. Paste a headline, email, or social post; the tool scores it on
six voice dimensions, explains each score, and suggests in-voice rewrites.

The scoring logic lives in [`voice-rubric.md`](./voice-rubric.md), grounded in
Anchour's real website copy ([`voice-samples.txt`](./voice-samples.txt)).

## How it works

- **Frontend** — plain static HTML/CSS/JS (no build step). One input, one
  output view.
- **Backend** — a single serverless function (`api/check.js`) that holds the
  Claude API key **server-side**. The browser calls `/api/check`; the function
  calls Claude. The key is never exposed in client code or the bundle.
- **Model** — `claude-sonnet-5`, asked to score strictly against the rubric
  and return structured JSON (overall score, per-dimension breakdown with
  reasoning, and 1–2 rewrite suggestions).

## Setup

```sh
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run test:call            # confirm the Claude API connection
```

`ANTHROPIC_API_KEY` is read only from the environment (locally via
`.env.local`, in production via the Vercel project's environment variables).
It is gitignored and never committed.

## Deploy

Deploys to Vercel: static frontend from `public/`, serverless function from
`api/`. Set `ANTHROPIC_API_KEY` in the Vercel project settings.

## Status

Built incrementally:

1. ✅ Scaffold + serverless function with a verified API connection.
2. ⬜ Rubric-grounded system prompt + structured JSON scoring.
3. ⬜ Prompt tuning against on-voice / off-voice / borderline inputs.
4. ⬜ UI.

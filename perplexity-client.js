// perplexity-client.js
//
// Thin wrapper around the Perplexity chat completions endpoint.
// Deliberately dumb for the spike: no retries, no streaming, no schema
// validation yet — that's Phase 3. We just want to see what comes back.

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

// "sonar" is Perplexity's baseline model with web search grounding.
// Worth revisiting model choice once we're reconstructing the real
// prompts and comparing output quality against the existing Spaces.
const DEFAULT_MODEL = "sonar";

async function callPerplexity({ apiKey, systemPrompt, userPrompt, model = DEFAULT_MODEL }) {
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  const started = Date.now();

  const response = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const durationMs = Date.now() - started;
  const rawText = await response.text();

  if (!response.ok) {
    const err = new Error(`Perplexity API returned ${response.status}`);
    err.status = response.status;
    err.rawBody = rawText;
    err.durationMs = durationMs;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Perplexity itself always wraps in valid JSON at the transport level;
    // this catch is for genuinely malformed responses, not for the inner
    // "did the model return clean JSON copy" question — that's handled
    // in server.js so we can inspect it directly.
    parsed = null;
  }

  return { rawText, parsed, durationMs };
}

module.exports = { callPerplexity, DEFAULT_MODEL };

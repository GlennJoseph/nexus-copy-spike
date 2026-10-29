// perplexity-client.js
//
// The ONLY file that knows how to talk to Perplexity. The rest of the service
// calls callPerplexity() and gets back the same shape, whichever API is used.
//
// Two modes, picked by the PERPLEXITY_API_MODE environment variable:
//
//   legacy (default)  POST /chat/completions with model "sonar".
//                     This is what the spike used and it still works today,
//                     but Perplexity announced Sonar Chat Completions
//                     support ends 27 Sept 2026.
//   agent             POST /v1/agent (Perplexity's replacement).
//                     Written from Perplexity's docs, NOT yet tested against
//                     the real API. Test with: PERPLEXITY_API_MODE=agent node run-tests.js
//
// Returned shape (both modes):
//   { content, truncated, urls, usage: {inputTokens, outputTokens, costUsd},
//     durationMs, mode, model }
//
// Errors are thrown as PerplexityError with kind: timeout | network | http | bad_response

const MODE = (process.env.PERPLEXITY_API_MODE || "legacy").toLowerCase();

const LEGACY_URL = process.env.PERPLEXITY_URL || "https://api.perplexity.ai/chat/completions";
const AGENT_URL = process.env.PERPLEXITY_AGENT_URL || "https://api.perplexity.ai/v1/agent";

const LEGACY_MODEL = process.env.PERPLEXITY_MODEL || "sonar";
const AGENT_EFFORT = process.env.PERPLEXITY_EFFORT || "fast";
// Agent mode only. Set PERPLEXITY_WEB_SEARCH=off to write from the payload alone.
const AGENT_WEB_SEARCH = (process.env.PERPLEXITY_WEB_SEARCH || "on").toLowerCase() !== "off";

// Optional (legacy mode): ask Perplexity not to search retailer sites at all.
// Set PERPLEXITY_DENY_RETAILERS=on. A leading "-" means "exclude this domain".
// Perplexity allows about 20 domains. Check the result with run-tests.js: the
// "RETAILER SOURCES SEEN" line should disappear. If Perplexity rejects the
// field, turn this off and tell Camel.
const DENY_RETAILERS = (process.env.PERPLEXITY_DENY_RETAILERS || "off").toLowerCase() === "on";
const RETAILER_DOMAINS = [
  "harveynorman.com.au",
  "thegoodguys.com.au",
  "jbhifi.com.au",
  "binglee.com.au",
  "appliancesonline.com.au",
  "winnings.com.au",
  "amazon.com.au",
  "ebay.com.au",
  "kogan.com",
  "catch.com.au",
  "bunnings.com.au",
  "bigw.com.au",
  "myer.com.au",
  "davidjones.com",
  "officeworks.com.au",
  "costco.com.au",
].map((d) => "-" + d);

class PerplexityError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "PerplexityError";
    this.kind = kind; // timeout | network | http | bad_response
    this.status = extra.status ?? null;
    this.rawBody = extra.rawBody ?? null;
  }
}

function buildLegacyRequest({ systemPrompt, userPrompt, maxOutputTokens }) {
  const body = {
    model: LEGACY_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxOutputTokens,
  };
  if (DENY_RETAILERS) body.search_domain_filter = RETAILER_DOMAINS;
  return { url: LEGACY_URL, body };
}

function buildAgentRequest({ systemPrompt, userPrompt, maxOutputTokens }) {
  const body = {
    effort: AGENT_EFFORT,
    instructions: systemPrompt,
    input: userPrompt,
    max_output_tokens: maxOutputTokens,
  };
  if (AGENT_WEB_SEARCH) body.tools = [{ type: "web_search" }];
  return { url: AGENT_URL, body };
}

function readLegacy(data) {
  const choice = data.choices && data.choices[0];
  const urls = [];
  for (const r of data.search_results || []) if (r && r.url) urls.push(r.url);
  for (const c of data.citations || []) if (typeof c === "string") urls.push(c);
  return {
    content: choice && choice.message ? choice.message.content : null,
    truncated: !!choice && choice.finish_reason === "length",
    urls,
    usage: {
      inputTokens: data.usage ? data.usage.prompt_tokens : null,
      outputTokens: data.usage ? data.usage.completion_tokens : null,
      costUsd: data.usage && data.usage.cost ? data.usage.cost.total_cost : null,
    },
    model: data.model || LEGACY_MODEL,
  };
}

function readAgent(data) {
  if (data.error) {
    throw new PerplexityError("bad_response", `Perplexity agent error: ${JSON.stringify(data.error).slice(0, 300)}`);
  }
  if (data.status && data.status !== "completed" && data.status !== "incomplete") {
    throw new PerplexityError("bad_response", `Perplexity agent status: ${data.status}`);
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const content = output
    .filter((item) => item && item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part && part.type === "output_text")
    .map((part) => part.text)
    .join("");
  const urls = output
    .filter((item) => item && item.type === "search_results")
    .flatMap((item) => (item.results || []).map((r) => r && r.url))
    .filter(Boolean);
  return {
    content,
    truncated: data.status === "incomplete",
    urls,
    usage: {
      inputTokens: data.usage ? data.usage.input_tokens : null,
      outputTokens: data.usage ? data.usage.output_tokens : null,
      costUsd: data.usage && data.usage.cost ? data.usage.cost.total_cost : null,
    },
    model: data.model || `effort:${AGENT_EFFORT}`,
  };
}

async function callPerplexity({
  apiKey,
  systemPrompt,
  userPrompt,
  timeoutMs = 30000,
  maxOutputTokens = 2000,
  mode = MODE,
}) {
  const started = Date.now();
  const req =
    mode === "agent"
      ? buildAgentRequest({ systemPrompt, userPrompt, maxOutputTokens })
      : buildLegacyRequest({ systemPrompt, userPrompt, maxOutputTokens });

  let response;
  let rawText;
  try {
    response = await fetch(req.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    rawText = await response.text();
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new PerplexityError("timeout", `Perplexity did not answer within ${timeoutMs} ms`);
    }
    throw new PerplexityError("network", `Could not reach Perplexity: ${e.message}`);
  }

  if (!response.ok) {
    throw new PerplexityError("http", `Perplexity returned ${response.status}`, {
      status: response.status,
      rawBody: rawText.slice(0, 500),
    });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new PerplexityError("bad_response", "Perplexity returned something that is not JSON", {
      rawBody: rawText.slice(0, 500),
    });
  }

  const read = mode === "agent" ? readAgent(data) : readLegacy(data);
  if (typeof read.content !== "string" || read.content.trim() === "") {
    throw new PerplexityError("bad_response", "Perplexity returned an empty answer", {
      rawBody: rawText.slice(0, 500),
    });
  }

  return { ...read, durationMs: Date.now() - started, mode };
}

module.exports = { callPerplexity, PerplexityError, MODE };

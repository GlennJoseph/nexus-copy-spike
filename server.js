// server.js
//
// Minimal Cloud Run service for the feasibility spike.
// Mirrors the auth/logging/rate-limit patterns already set up in
// nexus-copy-service (Phase 1 skeleton) so this can be merged straight
// into that repo rather than treated as a separate thing.

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const pino = require("pino");
const pinoHttp = require("pino-http");
const rateLimit = require("express-rate-limit");

const { callPerplexity } = require("./perplexity-client");
const { TEST_PRODUCT, SYSTEM_PROMPT, buildUserPrompt } = require("./test-product");

const app = express();
const logger = pino(); // JSON output — Cloud Logging parses this natively

app.use(helmet());
app.use(express.json());
app.use(pinoHttp({ logger }));

// Per-instance in-memory limiter. Same caveat as Phase 1: this is NOT a
// global cap across Cloud Run instances. Fine for a single-developer
// spike; would need Firestore/Redis for a real shared limit later.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// --- Auth middleware -------------------------------------------------
// Shared-secret header, validated against a Secret Manager-injected env
// var. Same shape as the existing service-api-key check.
function requireApiKey(req, res, next) {
  const provided = req.header("X-API-Key");
  const expected = process.env.SERVICE_API_KEY;

  if (!expected) {
    req.log.error("SERVICE_API_KEY not set in environment");
    return res.status(500).json({ status: "failed", error: { code: "server_misconfigured" } });
  }

  if (!provided || provided !== expected) {
    return res.status(401).json({ status: "failed", error: { code: "unauthorized" } });
  }

  next();
}

// --- Routes ------------------------------------------------------------

// Unauthenticated — for uptime probes.
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Authenticated — proves the auth wiring didn't break.
app.get("/v1/ping", requireApiKey, (req, res) => {
  res.status(200).json({ status: "ok", message: "pong" });
});

// The actual spike: call Perplexity with the hardcoded fridge product
// and return the RAW response so we can see the real output shape.
app.post("/v1/generate-test", requireApiKey, async (req, res) => {
  const apiKey = process.env.PERPLEXITY_API_KEY;

  if (!apiKey) {
    req.log.error("PERPLEXITY_API_KEY not set in environment");
    return res.status(500).json({ status: "failed", error: { code: "server_misconfigured" } });
  }

  const userPrompt = buildUserPrompt(TEST_PRODUCT);

  try {
    const result = await callPerplexity({
      apiKey,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
    });

    req.log.info({ durationMs: result.durationMs }, "perplexity call succeeded");

    // Returning both the full raw Perplexity response AND, if we can find
    // it, the model's message content on its own — that inner content is
    // the bit that's supposed to be our strict JSON copy object. Seeing
    // both tells us whether it needs stripping/parsing before Phase 3.
    const messageContent = result.parsed?.choices?.[0]?.message?.content ?? null;

    let attemptedParse = null;
    let parseError = null;
    if (messageContent) {
      try {
        attemptedParse = JSON.parse(messageContent);
      } catch (e) {
        parseError = e.message;
      }
    }

    return res.status(200).json({
      status: "success",
      durationMs: result.durationMs,
      rawPerplexityResponse: result.parsed,
      extractedMessageContent: messageContent,
      parsedCopyObject: attemptedParse,
      parseError, // non-null means the model's content was NOT clean JSON as-is
    });
  } catch (err) {
    req.log.error({ err: err.message, status: err.status, rawBody: err.rawBody }, "perplexity call failed");
    return res.status(502).json({
      status: "failed",
      error: {
        code: "generation_failed",
        message: err.message,
        upstreamStatus: err.status ?? null,
      },
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  logger.info(`nexus-copy-spike listening on port ${port}`);
});

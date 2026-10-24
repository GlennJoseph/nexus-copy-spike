// server.js
//
// Cloud Run service for the Nexus copy generation endpoint (Camel).
// POST /v1/generate takes the Nexus product payload and returns the agreed
// JSON contract. The real work lives in generate.js.

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const pino = require("pino");
const pinoHttp = require("pino-http");
const rateLimit = require("express-rate-limit");

const crypto = require("crypto");
const { generateCopy } = require("./generate");

const app = express();
app.set("trust proxy", 1); // Cloud Run sits behind Google's proxy; needed so the rate limiter sees real client IPs
const logger = pino(); // JSON output — Cloud Logging parses this natively

app.use(helmet());
app.use(express.json({ limit: "256kb" }));
app.use(pinoHttp({ logger }));

// Per-instance in-memory limiter. Same caveat as Phase 1: this is NOT a
// global cap across Cloud Run instances. Fine for a single-developer
// spike; would need Firestore/Redis for a real shared limit later.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      status: "failed",
      error: { code: "rate_limited", message: "Too many requests. Try again shortly." },
    }),
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

// The real endpoint. Body = the Nexus product payload. Response = the agreed contract.
app.post("/v1/generate", requireApiKey, async (req, res) => {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    req.log.error("PERPLEXITY_API_KEY not set in environment");
    return res.status(500).json({ status: "failed", error: { code: "server_misconfigured" } });
  }

  // Use the caller's request ID if it sent a sensible one, otherwise make one.
  const sent = req.header("X-Request-ID") || "";
  const requestId = /^[A-Za-z0-9._:-]{1,100}$/.test(sent) ? sent : crypto.randomUUID();
  res.set("X-Request-ID", requestId);

  try {
    const { httpStatus, body, meta } = await generateCopy(req.body, { apiKey, requestId, log: req.log });
    req.log.info(
      { request_id: requestId, ean: body.ean, outcome: body.status, errorCode: body.error && body.error.code, ...meta },
      "generate finished"
    );
    return res.status(httpStatus).json(body);
  } catch (err) {
    req.log.error({ request_id: requestId, err: err.message }, "generate crashed");
    return res.status(500).json({
      status: "failed",
      request_id: requestId,
      product_id: "",
      ean: "",
      error: { code: "generation_failed", message: "Unexpected server error" },
    });
  }
});

// Catches bad JSON bodies and anything else that slipped through.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
    return res.status(err.status || 400).json({
      status: "failed",
      error: { code: "invalid_input", message: "Request body must be valid JSON under 256 KB" },
    });
  }
  req.log.error({ err: err.message }, "unhandled error");
  return res.status(500).json({ status: "failed", error: { code: "generation_failed", message: "Unexpected server error" } });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  logger.info(`nexus-copy-service listening on port ${port}`);
});
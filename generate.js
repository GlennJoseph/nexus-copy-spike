// generate.js
//
// The whole job in one function: Nexus payload in, contract response out.
//
//   generateCopy(payload, { apiKey, requestId, log })
//     -> { httpStatus, body, meta }
//
// body is exactly what Simple receives (success or error object).
// meta is for our own logs and for run-tests.js. It is never sent to Simple.
//
// It never throws for expected problems (bad input, timeouts, copy that fails
// the checks). Those come back as a failed body with the right error code.

const fs = require("fs");
const path = require("path");
const { callPerplexity } = require("./perplexity-client");
const { DOCS_ENABLED, retrieveDocuments } = require("./documents");
const { SOURCE_SEARCH, findOfficialSources } = require("./sources");
const {
  validateInput,
  preparePayload,
  extractJson,
  checkCopy,
  findRetailerSources,
  cleanReviewNotes,
} = require("./checks");

const PROMPT_VERSION = process.env.PROMPT_VERSION || "v0.3";

const MAX_ATTEMPTS = 2; // first try + one retry
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS) || 30000; // per Perplexity call
const TOTAL_BUDGET_MS = Number(process.env.TOTAL_BUDGET_MS) || 90000; // whole request. Simple's timeout is 2 minutes.
const MIN_RETRY_MS = 8000; // do not start a retry with less time than this left
const MAX_OUTPUT_TOKENS = 2500; // cost cap per call (room for disclaimer_evidence)
// review_notes go back to Simple only when this is on, after Simple agrees to show them.
// DEBUG_RAW=on: keep the model's reply for every attempt that failed a check, in meta.raw (test runs only).
const DEBUG_RAW = String(process.env.DEBUG_RAW || "").toLowerCase() === "on";
const REVIEW_NOTES = String(process.env.REVIEW_NOTES || "").toLowerCase() === "on";

const noopLog = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------
const promptCache = {};
function loadPrompt(version) {
  if (!/^v\d+\.\d+$/.test(version)) throw new Error(`Bad prompt version: ${version}`);
  if (!promptCache[version]) {
    promptCache[version] = fs.readFileSync(path.join(__dirname, "prompts", version, "system.md"), "utf8");
  }
  return promptCache[version];
}

function buildUserPrompt(product, docText = "") {
  let p = `Generate NPR copy for this product:\n\n${JSON.stringify(product, null, 2)}`;
  if (docText) {
    p +=
      "\n\nDISCLAIMER SOURCES (supplier documents for this product: Nexus attachments or the official manufacturer website. " +
      "Use them ONLY for the disclaimers field. Do not take any feature, name, app, accessory, number or claim from them into the copy. " +
      "Every statement about the product must come from the product data above. A document may describe several models, so it can mention things this product does not have):\n\n" +
      docText;
  }
  return p;
}

// Checks that only concern disclaimers. If these are the only thing wrong after
// the retry, the copy is returned without disclaimers instead of failing.
const DISCLAIMER_CHECKS = new Set([
  "orphan_sup",
  "sup_spacing",
  "disclaimer_no_source",
  "disclaimer_format",
  "disclaimer_numbering",
  "sup_mismatch",
  "evidence_missing",
  "evidence_untraceable",
  "disclaimer_figure",
  "disclaimer_claim_word",
  "claim_unrelated",
]);

// Style rules that matter, but not enough to fail the whole request. The model
// gets one retry. If one of these is still broken, the copy goes back anyway
// (a person reviews every draft in Nexus) and the check is logged as a warning.
const SOFT_CHECKS = new Set(["long_words_low", "opening_product_first", "same_opening", "health_claim", "doc_only_term", "sup_position", "short_claim", "stat_no_disclaimer"]);

function dropDisclaimers(obj) {
  return {
    ...obj,
    npr_long_copy: String(obj.npr_long_copy).replace(/\s*<sup>\s*\d+\s*<\/sup>/gi, ""),
    disclaimers: "",
    disclaimer_evidence: [],
  };
}

function feedbackText(errors) {
  return (
    "\n\nYour previous reply broke these rules. Write the copy again, fix every point, " +
    "and return only the JSON object:\n" +
    errors.map((e) => `- ${e.message}`).join("\n")
  );
}

// ---------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------
function failed(httpStatus, ids, code, message, meta) {
  return {
    httpStatus,
    body: {
      status: "failed",
      request_id: ids.request_id,
      product_id: ids.product_id,
      ean: ids.ean,
      error: { code, message },
    },
    meta,
  };
}

// The model names the sentence each disclaimer qualifies (disclaimer_evidence[].claim). The service
// puts the <sup> tags in, at the end of that sentence before the full stop, and numbers the
// disclaimers in order of first use. The model never has to get the tag format right, and any
// tags it wrote itself are replaced.
// Returns the object unchanged when there is nothing to tag, or when a disclaimer names no claim
// sentence (the checks then judge the model's own tags).
const SENTENCE_END = /[.!?](?=\s|$)/;
const sentenceEndFrom = (text, from) => {
  const m = text.slice(from).match(SENTENCE_END);
  return m ? from + m.index : text.length;
};
const keyWords = (t) =>
  new Set((String(t).toLowerCase().match(/[a-z]{4,}/g) || []).map((w) => w.slice(0, 5)));

// Index of the end of the sentence a claim belongs to, or -1.
function claimEnd(long, claim) {
  const c = String(claim).replace(/[\s.!?]+$/, "").trim();
  if (!c) return -1;
  let i = long.indexOf(c);
  if (i < 0) i = long.toLowerCase().indexOf(c.toLowerCase());
  if (i >= 0) return sentenceEndFrom(long, i + c.length);
  // The model paraphrased the claim a little: use the sentence that shares the most words with it.
  const want = keyWords(c);
  if (want.size < 3) return -1;
  let best = -1;
  let bestScore = 0;
  for (const m of long.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)) {
    const have = keyWords(m[0]);
    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    const score = shared / (want.size + have.size - shared);
    if (score > bestScore) {
      bestScore = score;
      best = m.index + m[0].replace(/[.!?]+$/, "").length;
    }
  }
  return bestScore >= 0.5 ? best : -1;
}

function tagDisclaimers(obj) {
  const disc = String(obj.disclaimers || "").trim();
  const ev = Array.isArray(obj.disclaimer_evidence) ? obj.disclaimer_evidence : [];
  if (!disc || !ev.length) return obj;
  const entries = [];
  for (const line of disc.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^\(\s*(\d+)\s*\)\s+(\S.*)$/);
    if (!m) return obj;
    entries.push({ n: Number(m[1]), text: m[2] });
  }
  const claims = entries.map((e) => {
    const item = ev.find((x) => x && Number(x.n) === e.n && typeof x.claim === "string" && x.claim.trim());
    return item ? item.claim : null;
  });
  if (claims.some((c) => !c)) return obj;
  const long = String(obj.npr_long_copy || "").replace(/[ \t]*<sup>\s*\d+\s*<\/sup>/gi, "");
  const placed = [];
  for (let k = 0; k < entries.length; k++) {
    const end = claimEnd(long, claims[k]);
    if (end < 0) return obj;
    placed.push({ old: entries[k].n, text: entries[k].text, end });
  }
  // New numbers follow the order the tags appear in the copy.
  const order = [...placed].sort((a, b) => a.end - b.end || a.old - b.old);
  order.forEach((p, idx) => (p.n = idx + 1));
  let out = long;
  const ends = [...new Set(order.map((p) => p.end))].sort((a, b) => b - a);
  for (const end of ends) {
    const tags = order.filter((p) => p.end === end).map((p) => ` <sup>${p.n}</sup>`).join("");
    out = out.slice(0, end) + tags + out.slice(end);
  }
  return {
    ...obj,
    npr_long_copy: out,
    disclaimers: order.map((p) => `(${p.n}) ${p.text}`).join("\n"),
    disclaimer_evidence: ev.map((x) => {
      const p = order.find((q) => x && q.old === Number(x.n));
      return p ? { ...x, n: p.n } : x;
    }),
  };
}

// The success response. Evidence quotes never go to Simple. review_notes go only when REVIEW_NOTES=on.
function success(ids, promptVersion, obj, extraNotes = []) {
  const body = {
    status: "success",
    request_id: ids.request_id,
    product_id: ids.product_id,
    ean: ids.ean,
    prompt_version: promptVersion,
    generated_at: new Date().toISOString(),
    copy: {
      npr_heading: obj.npr_heading.trim(),
      npr_short_copy: obj.npr_short_copy.trim(),
      npr_long_copy: obj.npr_long_copy.trim(),
      disclaimers: obj.disclaimers.trim(),
    },
  };
  const notes = cleanReviewNotes(obj.review_notes).concat(extraNotes).slice(0, 5);
  if (REVIEW_NOTES) body.review_notes = notes;
  return { body, notes };
}

// What to do about an error from callPerplexity.
function classify(e) {
  if (e.kind === "timeout") return { httpStatus: 504, code: "timeout", retry: true };
  if (e.kind === "network") return { httpStatus: 502, code: "generation_failed", retry: true };
  if (e.kind === "http" && e.status === 429) return { httpStatus: 429, code: "rate_limited", retry: false };
  if (e.kind === "http" && e.status >= 500) return { httpStatus: 502, code: "generation_failed", retry: true };
  return { httpStatus: 502, code: "generation_failed", retry: false };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function generateCopy(rawProduct, { apiKey, requestId, log = noopLog, promptVersion = PROMPT_VERSION } = {}) {
  const started = Date.now();
  const ids = {
    request_id: requestId || "",
    product_id: rawProduct && rawProduct.id != null ? String(rawProduct.id).trim() : "",
    ean: rawProduct && rawProduct.ean != null ? String(rawProduct.ean).trim() : "",
  };
  const meta = {
    promptVersion,
    attempts: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    failedChecks: [],
    retriedBecause: [],
    warnings: [],
    stats: {},
    retailerSources: [],
    mode: null,
    documents: [],
  };
  const finish = (result) => {
    meta.durationMs = Date.now() - started;
    return result;
  };

  // 1. Input
  const missing = validateInput(rawProduct);
  if (missing.length) {
    return finish(failed(400, ids, "invalid_input", `Missing or invalid fields: ${missing.join(", ")}`, meta));
  }
  const product = preparePayload(rawProduct);
  if (!ids.product_id) ids.product_id = ids.ean;

  // 2. Disclaimer documents (only when DOCS_ENABLED=on). Never blocks the copy.
  let docText = "";
  if (DOCS_ENABLED) {
    try {
      const docs = await retrieveDocuments(rawProduct, { log });
      docText = docs.text;
      meta.documents = docs.report;
      log.info({ request_id: ids.request_id, found: docs.found, used: docs.used, ms: docs.ms }, "documents retrieved");
    } catch (e) {
      log.warn({ request_id: ids.request_id, err: e.message }, "document retrieval failed, continuing without");
    }
  }

  // 2b. No attachments to read: look for the official manufacturer sources (SOURCE_SEARCH=on).
  // Steps 3 and 4 of the source hierarchy. Never blocks the copy.
  if (SOURCE_SEARCH && !docText) {
    try {
      const found = await findOfficialSources(rawProduct, { apiKey, log });
      docText = found.text;
      meta.sources = { used: found.used, skipped: found.skipped, report: found.report, ms: found.ms };
      meta.usage.costUsd += found.costUsd || 0;
      log.info({ request_id: ids.request_id, used: found.used, skipped: found.skipped, ms: found.ms }, "official sources searched");
    } catch (e) {
      log.warn({ request_id: ids.request_id, err: e.message }, "source search failed, continuing without");
    }
  }

  // 3. Generate, check, retry once with feedback
  const systemPrompt = loadPrompt(promptVersion);
  const userPrompt = buildUserPrompt(product, docText);
  const sourceText = JSON.stringify(product);

  let lastProblem = null; // { type: "api", ...classify } or { type: "checks", errors }
  let lastObj = null; // last parsed reply, for the disclaimer fallback
  let feedback = "";
  const urls = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (attempt > 1 && remaining < MIN_RETRY_MS) break;
    meta.attempts = attempt;

    let result;
    try {
      result = await callPerplexity({
        apiKey,
        systemPrompt,
        userPrompt: userPrompt + feedback,
        timeoutMs: Math.min(CALL_TIMEOUT_MS, remaining),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
    } catch (e) {
      const c = classify(e);
      log.warn({ request_id: ids.request_id, attempt, kind: e.kind, status: e.status, rawBody: e.rawBody }, e.message);
      lastProblem = { type: "api", ...c, message: e.message };
      if (!c.retry) break;
      continue;
    }

    meta.mode = result.mode;
    meta.usage.inputTokens += result.usage.inputTokens || 0;
    meta.usage.outputTokens += result.usage.outputTokens || 0;
    meta.usage.costUsd += result.usage.costUsd || 0;
    urls.push(...result.urls);

    let errors;
    let obj = null;
    if (result.truncated) {
      errors = [{ check: "truncated", message: "The reply was cut off. Keep the copy shorter." }];
    } else {
      obj = extractJson(result.content);
      if (!obj) errors = [{ check: "not_json", message: "The reply was not a single valid JSON object. Return only the JSON object." }];
    }

    if (obj && obj.insufficient_data === true) {
      meta.retailerSources = findRetailerSources(urls);
      const why = typeof obj.reason === "string" ? obj.reason : "not enough product data";
      return finish(failed(422, ids, "invalid_input", `Not enough product data to write copy: ${why}`, meta));
    }

    if (obj) {
      obj = tagDisclaimers(obj);
      lastObj = obj;
      const checked = checkCopy(obj, { product, sourceText, documentText: docText });
      errors = checked.errors;
      meta.warnings = checked.warnings.map((w) => w.check);
      meta.stats = checked.stats;
    }

    if (errors.length === 0) {
      meta.failedChecks = [];
      meta.retailerSources = findRetailerSources(urls);
      const ok = success(ids, promptVersion, obj);
      meta.reviewNotes = ok.notes;
      return finish({ httpStatus: 200, body: ok.body, meta });
    }

    if (DEBUG_RAW) {
      meta.raw = meta.raw || [];
      meta.raw.push({ attempt, errors: errors.map((e) => e.message), reply: String(result.content).slice(0, 6000) });
    }
    meta.failedChecks = errors.map((e) => e.check);
    if (attempt === 1) meta.retriedBecause = meta.failedChecks.slice();
    log.warn({ request_id: ids.request_id, attempt, checks: meta.failedChecks }, "copy failed checks");
    lastProblem = { type: "checks", errors };
    feedback = feedbackText(errors);
  }

  // 4. Out of attempts
  meta.retailerSources = findRetailerSources(urls);

  // Only disclaimers and soft style rules are wrong: return the copy anyway.
  const allowed = (c) => DISCLAIMER_CHECKS.has(c) || SOFT_CHECKS.has(c);
  if (
    lastProblem &&
    lastProblem.type === "checks" &&
    lastObj &&
    lastProblem.errors.length &&
    lastProblem.errors.every((e) => allowed(e.check))
  ) {
    const hasDisclaimerProblem = lastProblem.errors.some((e) => DISCLAIMER_CHECKS.has(e.check));
    const final = hasDisclaimerProblem ? dropDisclaimers(lastObj) : lastObj;
    const again = checkCopy(final, { product, sourceText, documentText: hasDisclaimerProblem ? "" : docText });
    if (again.errors.every((e) => SOFT_CHECKS.has(e.check))) {
      meta.warnings = again.warnings
        .map((w) => w.check)
        .concat(again.errors.map((e) => e.check))
        .concat(hasDisclaimerProblem ? ["disclaimers_dropped"] : []);
      meta.stats = again.stats;
      meta.failedChecks = lastProblem.errors.map((e) => e.check);
      log.warn({ request_id: ids.request_id, checks: meta.failedChecks }, "returned with soft check failures");
      const extra = [];
      if (meta.failedChecks.includes("stat_no_disclaimer")) {
        extra.push("npr_long_copy: states a statistic with no disclaimer. Check it against the product sources before approving.");
      }
      if (meta.failedChecks.includes("short_claim")) {
        extra.push("npr_short_copy: contains a percentage, test or certification claim. Check it against the product sources.");
      }
      if (hasDisclaimerProblem) {
        extra.push("disclaimers: the drafted disclaimers could not be matched to a source, so none were returned. Check the long copy for claims that need one.");
      }
      const ok = success(ids, promptVersion, final, extra);
      meta.reviewNotes = ok.notes;
      return finish({ httpStatus: 200, body: ok.body, meta });
    }
  }

  if (lastProblem && lastProblem.type === "api") {
    return finish(failed(lastProblem.httpStatus, ids, lastProblem.code, lastProblem.message, meta));
  }
  const names = lastProblem ? lastProblem.errors.map((e) => e.check).join(", ") : "unknown";
  return finish(failed(502, ids, "generation_failed", `Copy failed quality checks after ${meta.attempts} attempt(s): ${names}`, meta));
}

module.exports = { generateCopy, PROMPT_VERSION, buildUserPrompt, tagDisclaimers };

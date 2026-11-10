// sources.js
//
// Finds the product's OFFICIAL manufacturer sources (product page, spec sheet,
// manual) when Nexus has no attachments to read. This is steps 3 and 4 of the
// source hierarchy. Turned on with SOURCE_SEARCH=on. Never blocks the copy.
//
//   1. Ask Perplexity for the exact model's pages, searching only the brand's own domains.
//   2. Keep only https URLs on those domains.
//   3. Read each one: PDF, web page, or the Shopify JSON version of a web page.
//   4. Keep a source only if the exact model number appears in its text.
//
// Brand domains live in brand-domains.json (or SOURCE_DOMAINS, a JSON object).
// A brand with no entry is skipped. Nothing is fetched outside those domains.

const fs = require("fs");
const path = require("path");
const { callPerplexity } = require("./perplexity-client");
const { retrieveDocuments, mentionsModel } = require("./documents");
const { extractJson } = require("./checks");

const SOURCE_SEARCH = String(process.env.SOURCE_SEARCH || "").toLowerCase() === "on";

const DEFAULTS = {
  maxSources: Number(process.env.SOURCE_MAX) || 4,
  searchTimeoutMs: Number(process.env.SOURCE_SEARCH_TIMEOUT_MS) || 12000,
  budgetMs: Number(process.env.SOURCE_BUDGET_MS) || 15000, // reading all sources together
  pageTimeoutMs: 10000,
  maxPageBytes: 2 * 1024 * 1024,
  maxRedirects: 2,
  maxCharsPerSource: 10000,
  maxCharsTotal: 24000,
  allowHttp: String(process.env.DOC_ALLOW_HTTP || "").toLowerCase() === "on", // tests only
};

const SEARCH_SYSTEM =
  "You find official manufacturer sources for one exact product. " +
  "Use only pages on the allowed domains. Match the exact model number. " +
  "Never guess a URL: only return URLs that appeared in your search results. " +
  'Reply with JSON only: {"product_page":url|null,"spec_sheet":url|null,"manual":url|null,"other":[urls],"notes":"one line"}. ' +
  "spec_sheet and manual should be direct PDF links when they exist.";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
};

// ---------------------------------------------------------------------
// Brand domains
// ---------------------------------------------------------------------
function loadBrandDomains() {
  let table = {};
  try {
    table = JSON.parse(fs.readFileSync(path.join(__dirname, "brand-domains.json"), "utf8"));
  } catch (e) {
    /* no file: only SOURCE_DOMAINS applies */
  }
  if (process.env.SOURCE_DOMAINS) {
    try {
      table = { ...table, ...JSON.parse(process.env.SOURCE_DOMAINS) };
    } catch (e) {
      /* ignore a bad value */
    }
  }
  const out = {};
  for (const [brand, list] of Object.entries(table)) {
    if (brand.startsWith("_")) continue;
    out[normBrand(brand)] = [].concat(list).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  }
  return out;
}
const normBrand = (b) => String(b || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function domainsFor(brandName, table = loadBrandDomains()) {
  return table[normBrand(brandName)] || [];
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
};
const onDomains = (host, domains) => domains.some((d) => host === d || host.endsWith("." + d));

// ---------------------------------------------------------------------
// Reading a web page
// ---------------------------------------------------------------------
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|tr|h\d|br|section)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// GET with redirects checked by hand: every hop must stay on the brand's domains and use https.
async function safeGet(url, domains, opts, deadline) {
  let current = url;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch (e) {
      return { ok: false, reason: "bad_url" };
    }
    if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return { ok: false, reason: "not_https" };
    if (!onDomains(u.hostname.toLowerCase(), domains)) return { ok: false, reason: "host_not_allowed" };
    const left = deadline - Date.now();
    if (left < 500) return { ok: false, reason: "timeout" };
    let res;
    try {
      res = await fetch(current, {
        headers: BROWSER_HEADERS,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(opts.pageTimeoutMs, left)),
      });
    } catch (e) {
      return { ok: false, reason: e.name === "TimeoutError" ? "timeout" : "network" };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, status: res.status };
    const type = res.headers.get("content-type") || "";
    const declared = Number(res.headers.get("content-length")) || 0;
    if (declared > opts.maxPageBytes) return { ok: false, reason: "too_large" };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > opts.maxPageBytes) return { ok: false, reason: "too_large" };
    return { ok: true, type, buf, url: current };
  }
  return { ok: false, reason: "too_many_redirects" };
}

// Shopify stores publish each product as JSON at <product url>.js
function shopifyUrl(url) {
  try {
    const u = new URL(url);
    if (!/\/products\/[^/]+$/.test(u.pathname.replace(/\.js$/, ""))) return null;
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(/\.(js|oembed|json)$/, "") + ".js";
    return u.toString();
  } catch (e) {
    return null;
  }
}

async function readPage(url, domains, opts, deadline) {
  let r = await safeGet(url, domains, opts, deadline);
  if (r.ok && /pdf/i.test(r.type)) return { kind: "pdf_via_page", ok: false, reason: "use_pdf_reader" };
  if (!r.ok && (r.status === 429 || r.status === 403 || r.status === 503)) {
    const js = shopifyUrl(url);
    if (js) {
      const j = await safeGet(js, domains, opts, deadline);
      if (j.ok) {
        try {
          const data = JSON.parse(j.buf.toString("utf8"));
          const text = [data.title, htmlToText(data.description || "")].filter(Boolean).join("\n");
          return { kind: "shopify_json", ok: true, text };
        } catch (e) {
          return { kind: "shopify_json", ok: false, reason: "bad_json" };
        }
      }
    }
  }
  if (!r.ok) return { kind: "web_page", ok: false, reason: r.reason };
  return { kind: "web_page", ok: true, text: htmlToText(r.buf.toString("utf8")) };
}

// Pages carry a lot of menu text. Start a little before the first mention of the model.
function windowAround(text, modelNo, max) {
  if (text.length <= max) return text;
  const m = String(modelNo).trim();
  const idx = text.toLowerCase().indexOf(m.toLowerCase());
  const start = Math.max(0, (idx >= 0 ? idx : 0) - 1500);
  return text.slice(start, start + max);
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function findOfficialSources(rawProduct, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const log = options.log || { info() {}, warn() {} };
  const started = Date.now();
  const out = { text: "", report: [], used: 0, costUsd: 0, ms: 0, skipped: null };
  const done = () => {
    out.ms = Date.now() - started;
    return out;
  };

  const brand = rawProduct && rawProduct.brand && rawProduct.brand.name ? String(rawProduct.brand.name) : "";
  const modelNo = rawProduct && rawProduct.modelNo ? String(rawProduct.modelNo).trim() : "";
  const domains = opts.domains || domainsFor(brand);
  if (!domains.length) {
    out.skipped = "no_domains_for_brand";
    return done();
  }
  if (modelNo.replace(/[^A-Za-z0-9]/g, "").length < 3) {
    out.skipped = "model_number_too_short";
    return done();
  }
  if (!opts.apiKey) {
    out.skipped = "no_api_key";
    return done();
  }

  // 1. Ask Perplexity where the sources are.
  let found;
  try {
    const name = rawProduct.heading ? `Product name: ${String(rawProduct.heading).slice(0, 150)}\n` : "";
    found = await callPerplexity({
      apiKey: opts.apiKey,
      systemPrompt: SEARCH_SYSTEM,
      userPrompt:
        `Brand: ${brand}\nModel number: ${modelNo}\n${name}Market: Australia\n` +
        "Find the official product page, the specification sheet and the user manual for this exact model. " +
        "If a document covers several models, say so in notes.",
      timeoutMs: opts.searchTimeoutMs,
      maxOutputTokens: 600,
      mode: "legacy",
      searchDomains: domains,
    });
  } catch (e) {
    out.skipped = `search_failed:${e.kind || "error"}`;
    out.error = e.message;
    log.warn({ err: e.message }, "source search failed, continuing without");
    return done();
  }
  out.costUsd = (found.usage && found.usage.costUsd) || 0;

  // 2. Pick the candidate URLs.
  const obj = extractJson(found.content) || {};
  const wanted = [];
  for (const k of ["spec_sheet", "manual", "product_page"]) if (obj[k]) wanted.push(obj[k]);
  if (Array.isArray(obj.other)) wanted.push(...obj.other.slice(0, 2));
  // Official PDFs Perplexity looked at that name the model in their address.
  const modelKey = modelNo.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const u of found.urls || []) {
    if (/\.pdf(\?|#|$)/i.test(u) && decodeURIComponent(u).toLowerCase().replace(/[^a-z0-9]/g, "").includes(modelKey)) wanted.push(u);
  }
  const candidates = [];
  for (const u of wanted) {
    if (typeof u !== "string" || candidates.includes(u)) continue;
    const host = hostOf(u);
    const httpsOk = u.startsWith("https://") || (opts.allowHttp && u.startsWith("http://"));
    if (!httpsOk || !onDomains(host, domains)) {
      out.report.push({ url: u, ok: false, reason: "not_an_official_https_url" });
      continue;
    }
    candidates.push(u);
  }
  const picked = candidates.slice(0, opts.maxSources);
  if (!picked.length) {
    out.skipped = "nothing_found";
    return done();
  }

  // 3 and 4. Read each source. The model number must appear in its text.
  const deadline = started + opts.searchTimeoutMs + opts.budgetMs;
  const results = await Promise.all(
    picked.map(async (url) => {
      const t0 = Date.now();
      try {
        if (/\.pdf(\?|#|$)/i.test(url)) {
          const r = await retrieveDocuments(
            { productdocuments: [{ id: "src", uri: url }] },
            { hosts: domains, allowHttp: opts.allowHttp, maxDocs: 1, requireModel: modelNo, budgetMs: opts.budgetMs, log }
          );
          const d = r.report[0] || {};
          return { url, kind: "pdf", ok: !!d.ok, reason: d.reason || null, chars: d.chars || 0, ms: Date.now() - t0, text: r.text };
        }
        const page = await readPage(url, domains, opts, deadline);
        if (page.reason === "use_pdf_reader") {
          const r = await retrieveDocuments(
            { productdocuments: [{ id: "src", uri: url }] },
            { hosts: domains, allowHttp: opts.allowHttp, maxDocs: 1, requireModel: modelNo, budgetMs: opts.budgetMs, log }
          );
          const d = r.report[0] || {};
          return { url, kind: "pdf", ok: !!d.ok, reason: d.reason || null, chars: d.chars || 0, ms: Date.now() - t0, text: r.text };
        }
        if (!page.ok) return { url, kind: page.kind, ok: false, reason: page.reason, chars: 0, ms: Date.now() - t0 };
        if (!mentionsModel(page.text, modelNo)) {
          return { url, kind: page.kind, ok: false, reason: "model_not_found", chars: 0, ms: Date.now() - t0 };
        }
        return { url, kind: page.kind, ok: true, reason: null, chars: page.text.length, ms: Date.now() - t0, text: page.text };
      } catch (e) {
        return { url, kind: "unknown", ok: false, reason: "error", chars: 0, ms: Date.now() - t0 };
      }
    })
  );

  let remaining = opts.maxCharsTotal;
  const parts = [];
  for (const r of results) {
    if (r.ok && remaining > 200) {
      const body = windowAround(r.text.replace(/^\[Document \d+:[^\]]*\]\n/, ""), modelNo, Math.min(opts.maxCharsPerSource, remaining));
      remaining -= body.length;
      parts.push(`[Document ${parts.length + 1}: official manufacturer ${r.kind === "pdf" ? "PDF" : "web page"}, ${hostOf(r.url)}]\n${body}`);
    }
    out.report.push({ url: r.url, kind: r.kind, ok: r.ok, reason: r.reason, chars: r.chars, ms: r.ms });
  }
  out.text = parts.join("\n\n");
  out.used = parts.length;
  if (!out.used) out.skipped = "no_source_named_the_model";
  return done();
}

module.exports = { SOURCE_SEARCH, findOfficialSources, domainsFor, loadBrandDomains, shopifyUrl, htmlToText };

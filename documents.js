// documents.js
//
// Phase 4: fetch the product's attachments from Nexus and turn them into text
// that the prompt can use as the ONLY source of disclaimers.
//
//   collectAttachments(rawProduct)        -> list of { kind, id, uri }
//   retrieveDocuments(rawProduct, opts)   -> { text, report }
//
// retrieveDocuments never throws. A document that cannot be fetched or read is
// skipped and the reason goes in `report` (for logs). If nothing usable comes
// back, `text` is "" and the service falls back to empty disclaimers.
//
// Safety: the URLs come from the request body, so they are untrusted.
//   - https only (http allowed only for local tests)
//   - host must be on the allowlist (default: retailpath.com.au and subdomains)
//   - redirects are followed by hand, and every hop is checked again
//   - size, time and page limits on every document

const DOCS_ENABLED = String(process.env.DOCS_ENABLED || "").toLowerCase() === "on";

const ATTACHMENT_KEYS = [
  ["productbrochures", "brochure"],
  ["productdocuments", "document"],
  ["productusermanuals", "user manual"],
  ["productwarranties", "warranty"],
];

const DEFAULTS = {
  hosts: (process.env.DOC_HOSTS || "retailpath.com.au")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  allowHttp: String(process.env.DOC_ALLOW_HTTP || "").toLowerCase() === "on",
  // Nexus sends attachment links as http://. For allowlisted hosts we try https instead.
  // Set DOC_UPGRADE_HTTP=off to refuse http links outright.
  upgradeHttp: String(process.env.DOC_UPGRADE_HTTP || "on").toLowerCase() !== "off",
  maxDocs: Number(process.env.DOC_MAX_DOCS) || 6,
  maxBytes: Number(process.env.DOC_MAX_BYTES) || 10 * 1024 * 1024, // 10 MB, as in the proposal
  maxRedirects: 2,
  docTimeoutMs: Number(process.env.DOC_TIMEOUT_MS) || 8000, // one document
  budgetMs: Number(process.env.DOC_BUDGET_MS) || 12000, // all documents together
  maxCharsPerDoc: Number(process.env.DOC_MAX_CHARS) || 20000,
  maxCharsTotal: 50000,
  maxPages: 60,
};

// ---------------------------------------------------------------------
// Which attachments does the payload hold?
// ---------------------------------------------------------------------
function collectAttachments(raw) {
  const out = [];
  const seen = new Set();
  if (!raw || typeof raw !== "object") return out;
  for (const [key, kind] of ATTACHMENT_KEYS) {
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    for (const a of list) {
      if (!a || typeof a !== "object" || a.deleted) continue;
      const uri = typeof a.uri === "string" ? a.uri.trim() : "";
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      out.push({ kind, id: a.id != null ? String(a.id) : "", uri });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------
function checkUrl(uri, opts) {
  let u;
  try {
    u = new URL(uri);
  } catch (e) {
    return { ok: false, reason: "bad_url" };
  }
  const host = u.hostname.toLowerCase();
  const allowed = opts.hosts.some((h) => host === h || host.endsWith("." + h));
  let upgraded = false;
  if (u.protocol === "http:" && !opts.allowHttp) {
    // Only an allowlisted host is upgraded. Anything else is refused as before.
    if (opts.upgradeHttp && allowed) {
      u.protocol = "https:";
      upgraded = true;
    } else {
      return { ok: false, reason: "not_https" };
    }
  } else if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) {
    return { ok: false, reason: "not_https" };
  }
  if (!allowed) return { ok: false, reason: "host_not_allowed" };
  return { ok: true, url: u, upgraded };
}

// The file type comes from the extension at the end of the path.
// Returns "pdf", another extension (unsupported), or "" (none, so sniff the bytes).
function extensionOf(url) {
  const m = url.pathname.match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : "";
}

// ---------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------
async function download(uri, opts, deadline) {
  let current = uri;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const chk = checkUrl(current, opts);
    if (!chk.ok) throw Object.assign(new Error(chk.reason), { reason: chk.reason });
    if (hop === 0) {
      const ext = extensionOf(chk.url);
      if (ext && ext !== "pdf") throw Object.assign(new Error("unsupported_type"), { reason: `unsupported_type:${ext}` });
    }
    const left = deadline - Date.now();
    if (left < 500) throw Object.assign(new Error("timeout"), { reason: "timeout" });

    let res;
    try {
      res = await fetch(chk.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(opts.docTimeoutMs, left)),
        headers: { Accept: "application/pdf,*/*;q=0.5" },
      });
    } catch (e) {
      const t = e && (e.name === "TimeoutError" || e.name === "AbortError");
      throw Object.assign(new Error(t ? "timeout" : "network"), { reason: t ? "timeout" : "network" });
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw Object.assign(new Error("bad_redirect"), { reason: "bad_redirect" });
      current = new URL(loc, chk.url).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error("access_denied"), { reason: `http_${res.status}` });
    if (res.status === 404 || res.status === 410) throw Object.assign(new Error("not_found"), { reason: `http_${res.status}` });
    if (!res.ok) throw Object.assign(new Error("http_error"), { reason: `http_${res.status}` });

    const declared = Number(res.headers.get("content-length"));
    if (declared && declared > opts.maxBytes) throw Object.assign(new Error("too_large"), { reason: "too_large" });

    // Read the body in pieces so a missing or wrong Content-Length cannot get past the size cap.
    const chunks = [];
    let size = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > opts.maxBytes) {
          await reader.cancel();
          throw Object.assign(new Error("too_large"), { reason: "too_large" });
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e.reason) throw e;
      const t = e && (e.name === "TimeoutError" || e.name === "AbortError");
      throw Object.assign(new Error(t ? "timeout" : "network"), { reason: t ? "timeout" : "network" });
    }
    return Buffer.concat(chunks);
  }
  throw Object.assign(new Error("too_many_redirects"), { reason: "too_many_redirects" });
}

// ---------------------------------------------------------------------
// PDF -> text
// ---------------------------------------------------------------------
// pdfjs-dist 4.x legacy build. It is an ES module, so it is loaded with import().
let pdfjs = null;
async function getPdfjs() {
  if (!pdfjs) pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

function tidy(text) {
  return String(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Footnotes usually sit at the end of a page or document, so when a document is
// too long keep the start and the end, not just the start.
function clip(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return text.slice(0, half) + "\n[...]\n" + text.slice(-half);
}

async function pdfToText(buf, opts) {
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
    throw Object.assign(new Error("not_pdf"), { reason: "not_pdf" });
  }
  let doc;
  try {
    const lib = await getPdfjs();
    doc = await lib.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    throw Object.assign(new Error("unreadable_pdf"), { reason: "unreadable_pdf" });
  }
  try {
    // Very long PDFs: read the first half of the page allowance and the last half.
    const n = doc.numPages;
    const wanted = [];
    if (n <= opts.maxPages) {
      for (let i = 1; i <= n; i++) wanted.push(i);
    } else {
      const half = Math.floor(opts.maxPages / 2);
      for (let i = 1; i <= half; i++) wanted.push(i);
      for (let i = n - half + 1; i <= n; i++) wanted.push(i);
    }
    const pages = [];
    for (const i of wanted) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let s = "";
      for (const it of content.items) {
        if (typeof it.str !== "string") continue;
        s += it.str;
        if (it.hasEOL) s += "\n";
      }
      pages.push(s);
    }
    const text = tidy(pages.join("\n"));
    if (text.length < 40) throw Object.assign(new Error("no_text"), { reason: "no_text" }); // scanned images
    return { text, pages: n };
  } catch (e) {
    if (e.reason) throw e;
    throw Object.assign(new Error("unreadable_pdf"), { reason: "unreadable_pdf" });
  } finally {
    try {
      await doc.destroy();
    } catch (e) {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function retrieveDocuments(raw, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const log = options.log || { info() {}, warn() {} };
  const started = Date.now();
  const deadline = started + opts.budgetMs;
  // Files with a known non-PDF extension (png, jpg, tiff, doc, docx...) are skipped
  // without being downloaded, and they do not use up the document allowance.
  const everything = collectAttachments(raw);
  const skippedByType = [];
  const usable = [];
  for (const it of everything) {
    const chk = checkUrl(it.uri, opts);
    const ext = chk.ok ? extensionOf(chk.url) : "";
    if (chk.ok && ext && ext !== "pdf") {
      skippedByType.push({ kind: it.kind, id: it.id, ok: false, reason: `unsupported_type:${ext}`, pages: 0, bytes: 0, chars: 0, ms: 0 });
    } else {
      usable.push(it);
    }
  }
  const items = usable.slice(0, opts.maxDocs);

  // Download plus reading one PDF must finish inside the stage limit, so a heavy
  // PDF cannot hold up the copy. Downloads have their own (shorter) deadline.
  const stageMs = opts.budgetMs + (opts.parseExtraMs != null ? opts.parseExtraMs : 8000);
  const results = await Promise.all(
    items.map(async (it) => {
      const t0 = Date.now();
      const base = { kind: it.kind, id: it.id };
      let timer;
      try {
        const work = (async () => {
          const buf = await download(it.uri, opts, deadline);
          const { text, pages } = await pdfToText(buf, opts);
          return { buf, text, pages };
        })();
        work.catch(() => {}); // a late failure after the stage limit must not crash the process
        const limit = new Promise((_, rej) => {
          timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { reason: "timeout" })), stageMs);
        });
        const { buf, text, pages } = await Promise.race([work, limit]);
        return { ...base, ok: true, pages, bytes: buf.length, chars: text.length, ms: Date.now() - t0, text };
      } catch (e) {
        const reason = e.reason || "error";
        log.warn({ kind: it.kind, id: it.id, reason }, "document skipped");
        return { ...base, ok: false, reason, ms: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    })
  );

  // Build the text block for the prompt, within the total size cap.
  let remaining = opts.maxCharsTotal;
  const parts = [];
  for (const r of results) {
    if (!r.ok || remaining <= 200) continue;
    const body = clip(r.text, Math.min(opts.maxCharsPerDoc, remaining));
    remaining -= body.length;
    parts.push(`[Document ${parts.length + 1}: ${r.kind}, ${r.pages} page(s)]\n${body}`);
  }

  const report = skippedByType.concat(results.map((r) => ({
    kind: r.kind,
    id: r.id,
    ok: r.ok,
    reason: r.reason || null,
    pages: r.pages || 0,
    bytes: r.bytes || 0,
    chars: r.chars || 0,
    ms: r.ms,
  })));
  return { text: parts.join("\n\n"), report, found: everything.length, used: parts.length, ms: Date.now() - started };
}

module.exports = { DOCS_ENABLED, collectAttachments, retrieveDocuments, checkUrl, extensionOf };

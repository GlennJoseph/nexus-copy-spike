// source-spike.js
//
// Spike: can Perplexity find a product's OFFICIAL manufacturer sources (product
// page, spec sheet, manual) when search is limited to the brand's own domains,
// and can the service then read them for disclaimer footnotes?
//
//   PERPLEXITY_API_KEY=... node source-spike.js "<brand>" "<model no>" "<domain1,domain2>" ["<product name>"]
//
// Example:
//   node source-spike.js "Gaf Control" "HVF40B" "gafcontrol.com.au" "High Velocity Fan 40cm"
//   node source-spike.js "Haier" "HDHP100AN1" "haier.com,haier.com.au"
//
// Prints: the answer, every URL Perplexity looked at (and whether it is on your
// domains), then tries to read each official URL (PDF or web page) and shows
// lines that look like footnotes. Writes the full result to source-spike-out.json.
// Run it on 5 to 8 products across brands and send the output. It tells us
// which brands work and which need a different route.

const fs = require("fs");
const { callPerplexity } = require("./perplexity-client");
const { retrieveDocuments } = require("./documents");

const SYSTEM =
  "You find official manufacturer sources for one exact product. " +
  "Use only pages on the allowed domains. Match the exact model number. " +
  "Never guess a URL: only return URLs that appeared in your search results. " +
  'Reply with JSON only: {"product_page":url|null,"spec_sheet":url|null,"manual":url|null,"other":[urls],"notes":"one line"}. ' +
  "spec_sheet and manual should be direct PDF links when they exist.";

function userPrompt(brand, model, name) {
  return (
    `Brand: ${brand}\nModel number: ${model}\n${name ? `Product name: ${name}\n` : ""}` +
    "Market: Australia\n" +
    "Find the official product page, the specification sheet and the user manual for this exact model. " +
    "If a document covers several models, say so in notes."
  );
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
};
const onDomains = (u, domains) => {
  const h = hostOf(u);
  return domains.some((d) => h === d || h.endsWith("." + d));
};

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h\d|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const FOOT = /(tested|based on|compared|independent|accredited|certified|results|measured|up to|\bvs\b|according|conditions|standard|AS\/NZS|IEC|ISO)/i;

async function readUrl(url, domains) {
  if (/\.pdf(\?|#|$)/i.test(url)) {
    const r = await retrieveDocuments({ productdocuments: [{ id: "spike", uri: url }] }, { hosts: domains, maxDocs: 1 });
    const d = r.report[0] || {};
    return { kind: "pdf", ok: !!d.ok, reason: d.reason || null, pages: d.pages || 0, text: r.text || "" };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!res.ok) return { kind: "html", ok: false, reason: `http_${res.status}`, text: "" };
    const type = res.headers.get("content-type") || "";
    if (/pdf/i.test(type)) {
      const r = await retrieveDocuments({ productdocuments: [{ id: "spike", uri: url }] }, { hosts: domains, maxDocs: 1 });
      const d = r.report[0] || {};
      return { kind: "pdf", ok: !!d.ok, reason: d.reason || null, pages: d.pages || 0, text: r.text || "" };
    }
    return { kind: "html", ok: true, reason: null, text: htmlToText(await res.text()) };
  } catch (e) {
    return { kind: "html", ok: false, reason: e.name === "TimeoutError" ? "timeout" : "network", text: "" };
  }
}

async function main() {
  const [brand, model, domainArg, name] = process.argv.slice(2);
  if (!brand || !model || !domainArg) {
    console.error('Usage: node source-spike.js "<brand>" "<model>" "<domain1,domain2>" ["<product name>"]');
    process.exit(2);
  }
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.error("Set PERPLEXITY_API_KEY.");
    process.exit(2);
  }
  const domains = domainArg.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

  // Perplexity's search_domain_filter is an allow-list when entries have no "-" prefix.
  process.env.PERPLEXITY_DENY_RETAILERS = "off";
  const out = { brand, model, domains };
  const prevFetch = global.fetch;
  global.fetch = (url, opts) => {
    if (opts && typeof opts.body === "string" && opts.body.includes('"messages"')) {
      const b = JSON.parse(opts.body);
      b.search_domain_filter = domains;
      opts = { ...opts, body: JSON.stringify(b) };
    }
    return prevFetch(url, opts);
  };

  let p;
  try {
    p = await callPerplexity({
      apiKey,
      systemPrompt: SYSTEM,
      userPrompt: userPrompt(brand, model, name),
      timeoutMs: 40000,
      maxOutputTokens: 600,
      mode: "legacy",
    });
  } catch (e) {
    console.error(`Perplexity call failed: ${e.kind || ""} ${e.message}`);
    if (e.rawBody) console.error(e.rawBody);
    process.exit(1);
  }
  global.fetch = prevFetch;

  out.durationMs = p.durationMs;
  out.costUsd = p.usage.costUsd;
  out.answer = p.content;
  out.seen = [...new Set(p.urls)].map((u) => ({ url: u, official: onDomains(u, domains) }));
  console.log(`\n${brand} ${model}  (${p.durationMs} ms, cost ${p.usage.costUsd ?? "?"})`);
  console.log("ANSWER:", p.content.replace(/\s+/g, " ").slice(0, 600));
  console.log("\nURLs Perplexity looked at:");
  for (const s of out.seen) console.log(`  ${s.official ? "official" : "OTHER   "}  ${s.url}`);

  let parsed = null;
  try {
    parsed = JSON.parse(p.content.replace(/^```(?:json)?|```$/gim, "").trim());
  } catch (e) {
    /* answer was not JSON */
  }
  const picked = new Set();
  if (parsed) for (const k of ["spec_sheet", "manual", "product_page"]) if (parsed[k]) picked.add(parsed[k]);
  if (parsed && Array.isArray(parsed.other)) for (const u of parsed.other.slice(0, 2)) picked.add(u);
  for (const s of out.seen) if (s.official && /\.pdf(\?|#|$)/i.test(s.url)) picked.add(s.url);

  out.read = [];
  for (const url of [...picked].filter((u) => typeof u === "string" && onDomains(u, domains)).slice(0, 5)) {
    const r = await readUrl(url, domains);
    const lines = r.text.split("\n").filter((l) => FOOT.test(l) && l.trim().length > 25).slice(0, 8).map((l) => l.trim().slice(0, 200));
    const modelHit = r.text.toLowerCase().includes(String(model).toLowerCase());
    out.read.push({ url, kind: r.kind, ok: r.ok, reason: r.reason, chars: r.text.length, modelNoFound: modelHit, footnoteLikeLines: lines });
    console.log(`\nREAD ${url}\n  ${r.kind} ${r.ok ? "ok" : "FAILED " + r.reason}, ${r.text.length} chars, model number ${modelHit ? "found" : "NOT found"} in text`);
    for (const l of lines) console.log("   -", l);
  }
  const rejected = [...picked].filter((u) => typeof u === "string" && !onDomains(u, domains));
  if (rejected.length) console.log("\nSkipped (not on your domains):", rejected.join(", "));
  fs.writeFileSync("source-spike-out.json", JSON.stringify(out, null, 2));
  console.log("\nFull result written to source-spike-out.json");
}

main();

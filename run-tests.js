// run-tests.js
//
// Runs every payload in tests/payloads/ through the same generateCopy()
// function the real endpoint uses, then prints a pass/fail table and saves
// the full results to tests/results/ so versions can be compared later.
//
//   node run-tests.js                     all payloads
//   node run-tests.js 9313139336898       only these EANs
//   PROMPT_VERSION=v0.2 node run-tests.js    try another prompt version
//   PERPLEXITY_API_MODE=agent node run-tests.js   try the new Perplexity API
//
// This calls the real Perplexity API (a fraction of a cent per product).
// For checks that cost nothing, use: npm test

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { generateCopy, PROMPT_VERSION } = require("./generate");
const { MODE } = require("./perplexity-client");

const PAYLOAD_DIR = path.join(__dirname, "tests", "payloads");
const RESULT_DIR = path.join(__dirname, "tests", "results");
const KNOWN_ISSUES_FILE = path.join(__dirname, "tests", "known-issues.json");

function loadKnownIssues() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_ISSUES_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

// "this X is designed for ..." style openings. Takes the first sentence of the
// long copy, drops the words that are in the heading (brand/product name), and
// keeps the next four words. Two products with the same frame = repetitive.
function openingFrame(copy) {
  const first = copy.npr_long_copy.split(/(?<=[.!?])\s/)[0] || "";
  const headingWords = new Set(copy.npr_heading.toLowerCase().match(/[a-z0-9]+/g) || []);
  const words = (first.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !headingWords.has(w));
  return words.slice(0, 4).join(" ");
}

async function main() {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.error("PERPLEXITY_API_KEY is not set (check your .env file).");
    process.exit(2);
  }

  const wanted = process.argv.slice(2);
  const files = fs
    .readdirSync(PAYLOAD_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)))
    .sort();
  if (files.length === 0) {
    console.error("No payload files found in tests/payloads/");
    process.exit(2);
  }

  const known = loadKnownIssues();
  console.log(`Prompt ${PROMPT_VERSION} | Perplexity mode: ${MODE} | ${files.length} product(s)\n`);

  const results = [];
  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(path.join(PAYLOAD_DIR, file), "utf8"));
    const ean = String(payload.ean || file.replace(".json", "")).trim();
    const out = await generateCopy(payload, { apiKey, requestId: `test-${ean}` });
    const ok = out.httpStatus === 200;
    const m = out.meta;

    const line = [
      ok ? "PASS" : "FAIL",
      ean,
      `tries ${m.attempts}`,
      ok ? `short ${m.stats.shortWords}w/${m.stats.shortChars}c` : out.body.error.code,
      ok ? `long ${m.stats.longWords}w/${m.stats.longChars}c/${m.stats.paragraphs}p` : "",
      `${m.durationMs}ms`,
      `$${m.usage.costUsd.toFixed(4)}`,
    ];
    console.log(line.filter(Boolean).join(" | "));
    if (!ok) console.log(`   ${out.body.error.message}`);
    if (m.retriedBecause.length) console.log(`   retried because: ${m.retriedBecause.join(", ")}`);
    if (m.warnings.length) console.log(`   warnings: ${m.warnings.join(", ")}`);
    if (m.documents && m.documents.length) {
      const d = m.documents.map((x) => (x.ok ? `${x.kind} ok (${x.pages}p, ${x.chars}c)` : `${x.kind} SKIPPED (${x.reason})`));
      console.log(`   documents: ${d.join("; ")}`);
    }
    if (ok && out.body.copy.disclaimers) console.log(`   disclaimers: ${out.body.copy.disclaimers.replace(/\n/g, " | ")}`);
    if (m.retailerSources.length) console.log(`   RETAILER SOURCES SEEN: ${m.retailerSources.join(", ")}`);
    for (const note of known[ean] || []) console.log(`   KNOWN DATA ISSUE: ${note}`);

    results.push({ ean, file, ok, httpStatus: out.httpStatus, body: out.body, meta: m, knownIssues: known[ean] || [] });
  }

  // Repetitive openings across products
  const frames = {};
  for (const r of results.filter((x) => x.ok)) {
    const f = openingFrame(r.body.copy);
    (frames[f] = frames[f] || []).push(r.ean);
  }
  const repeats = Object.entries(frames).filter(([, eans]) => eans.length > 1);
  if (repeats.length) {
    console.log("\nRepeated opening frames:");
    for (const [frame, eans] of repeats) console.log(`   "${frame}" used by ${eans.join(", ")}`);
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.reduce((s, r) => s + r.meta.usage.costUsd, 0);
  console.log(`\n${passed}/${results.length} passed | total cost $${total.toFixed(4)}`);

  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(RESULT_DIR, `${PROMPT_VERSION}-${MODE}-${stamp}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ promptVersion: PROMPT_VERSION, mode: MODE, ranAt: new Date().toISOString(), results }, null, 2)
  );
  console.log(`Saved ${path.relative(__dirname, outFile)}`);

  process.exit(passed === results.length ? 0 : 1);
}

main();

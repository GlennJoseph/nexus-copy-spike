// generate-docs.test.js
//
// End to end with fakes: a fake Perplexity and a fake Nexus file server, both
// on localhost. Checks that documents flow into the prompt and that invented
// disclaimers never reach Simple.   Run with:  npm test

const http = require("http");
const fs = require("fs");
const path = require("path");

// These must be set before the service files are loaded.
process.env.DOCS_ENABLED = "on";
process.env.DOC_HOSTS = "localhost";
process.env.DOC_ALLOW_HTTP = "on";
process.env.SOURCE_SEARCH = "on";
process.env.SOURCE_DOMAINS = JSON.stringify({ zorbo: ["localhost"] });
process.env.REVIEW_NOTES = "on";
const MOCK_PORT = 18000 + Math.floor(Math.random() * 1000);
process.env.PERPLEXITY_URL = `http://localhost:${MOCK_PORT}/chat/completions`;
delete process.env.PERPLEXITY_API_MODE;

const test = require("node:test");
const assert = require("node:assert");
const { generateCopy, tagDisclaimers } = require("./generate");

const PDF = fs.readFileSync(path.join(__dirname, "tests", "fixtures", "brochure.pdf"));
const SPEC = fs.readFileSync(path.join(__dirname, "tests", "fixtures", "spec-with-model.pdf"));
const SPEC_LINE = "Allergy Care cycle was independently tested to eliminate greater than 99.9% of bacteria.";
const FOOTNOTE = "Independently tested to eliminate greater than 99.9% of staphylococcus aureus and E. coli using the Allergy Care cycle.";

const COPY = (sup, disclaimers, evidence) => ({
  npr_heading: "Haier 10kg Heat Pump Dryer – Black",
  npr_short_copy: "Wet washing hanging around for days is no fun. This Haier heat pump dryer takes 10kg loads and uses less energy than a vented dryer, so everyday laundry costs you less.",
  npr_long_copy: [
    "Waiting days for a load of towels to dry on the line gets old fast, especially in winter. This Haier heat pump dryer takes loads up to 10kg, so you'll get through the family wash in fewer cycles and have clean clothes ready when you need them. It's built for busy households that want gentle drying without the running costs of a vented model.",
    `The Allergy Care cycle removes more bacteria with every load, which is handy for bedding and school uniforms${sup ? " <sup>1</sup>" : ""}. Heat pump technology dries at a lower temperature, which is kinder to your clothes and helps keep energy use down. That means woollens and delicates come out soft instead of shrunken, and your power bill won't jump when the dryer runs most days.`,
    "The control panel is easy to read, so you can pick a program in seconds, even when you're juggling a basket and a toddler. Choose from a range of cycles for towels, cottons and delicates, and use the delay start to dry overnight when it suits you. There's no need to stand and watch the clock or check the load every half hour.",
    "Finished in black, this dryer fits neatly into most laundries and sits well beside a washing machine. It's backed by a two year warranty, and it suits anyone who wants dependable drying without a vent kit or a hole in the wall. If you're tired of racks of washing taking over the living room, this one is worth a look.",
  ].join("\n\n"),
  disclaimers,
  disclaimer_evidence: evidence === undefined ? (disclaimers ? [{ n: 1, quote: FOOTNOTE }] : []) : evidence,
  review_notes: [],
});

let mock, scenario, lastPrompt, calls;
const docServer = http.createServer((req, res) => {
  if (req.url === "/a/nprFile.pdf") return res.writeHead(200).end(PDF);
  if (req.url === "/denied.pdf") return res.writeHead(403).end("no");
  if (req.url === "/spec.pdf") return res.writeHead(200).end(SPEC);
  res.writeHead(404).end();
});
let docBase;

test.before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      lastPrompt = (parsed.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
      calls++;
      const out = scenario(calls);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(out) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3000, completion_tokens: 400, cost: { total_cost: 0.001 } },
      }));
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  await new Promise((r) => docServer.listen(0, "127.0.0.1", r));
  docBase = `http://localhost:${docServer.address().port}`;
});
test.after(() => {
  mock.close();
  docServer.close();
});

const product = (uri) => ({
  ean: "9415112614457",
  heading: "Haier 10kg Heat Pump Dryer",
  modelNo: "HDHP10DB1",
  brand: { name: "Haier" },
  finish: "Black",
  defaultdisplaycategory: { name: "Dryers" },
  categoryAttributes: { "Capacity (kg)": 10, "Additional Features": "Allergy Care cycle" },
  productbrochures: uri ? [{ id: "h1", type: "ProductBrochure", uri }] : [],
  productdocuments: [],
  productusermanuals: [],
  productwarranties: [],
});
const run = async (sc, p) => {
  calls = 0;
  scenario = sc;
  return generateCopy(p, { apiKey: "k", requestId: "t", promptVersion: "v0.4" });
};

test("document footnote flows into the prompt and comes back as a disclaimer", async () => {
  const r = await run(() => COPY(true, `(1) ${FOOTNOTE}`), product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.ok(lastPrompt.includes("DISCLAIMER SOURCES"));
  assert.ok(lastPrompt.includes("staphylococcus aureus"));
  assert.strictEqual(r.body.copy.disclaimers, `(1) ${FOOTNOTE}`);
  assert.ok(r.body.copy.npr_long_copy.includes(" <sup>1</sup>"));
  assert.strictEqual(r.meta.attempts, 1);
  assert.strictEqual(r.meta.documents[0].ok, true);
});

test("an invented footnote is rejected, then fixed on the retry", async () => {
  const r = await run((n) => (n === 1 ? COPY(true, "(1) Tested by an independent lab to remove 100% of all germs forever.", [{ n: 1, quote: "Tested by an independent lab to remove 100% of all germs forever." }]) : COPY(true, `(1) ${FOOTNOTE}`)), product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.attempts, 2);
  assert.deepStrictEqual(r.meta.retriedBecause, ["evidence_untraceable"]);
  assert.strictEqual(r.body.copy.disclaimers, `(1) ${FOOTNOTE}`);
});

test("invented footnote twice: copy still returns, without disclaimers or tags", async () => {
  const r = await run(() => COPY(true, "(1) Tested by an independent lab to remove 100% of all germs forever.", [{ n: 1, quote: "Tested by an independent lab to remove 100% of all germs forever." }]), product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.body.copy.disclaimers, "");
  assert.ok(!r.body.copy.npr_long_copy.includes("<sup>"));
  assert.ok(!r.body.copy.npr_long_copy.includes(" ."), "no stray space left where the tag was");
  assert.ok(r.meta.warnings.includes("disclaimers_dropped"));
});

test("no attachments: nothing about disclaimers in the prompt, and disclaimers stay empty", async () => {
  const r = await run(() => COPY(false, ""), product(null));
  assert.strictEqual(r.httpStatus, 200);
  assert.ok(!lastPrompt.includes("DISCLAIMER SOURCES"));
  assert.strictEqual(r.body.copy.disclaimers, "");
});

test("no source but the model writes a disclaimer anyway: it is dropped", async () => {
  const r = await run(() => COPY(true, `(1) ${FOOTNOTE}`), product(null));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.body.copy.disclaimers, "");
  assert.ok(!r.body.copy.npr_long_copy.includes("<sup>"));
});

test("a document that cannot be fetched does not stop the copy", async () => {
  const r = await run(() => COPY(false, ""), product(`${docBase}/denied.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.documents[0].reason, "http_403");
});

test("a soft style problem after the retry still returns the copy, with a warning", async () => {
  const productFirst = { ...COPY(false, ""), npr_short_copy: "This Haier heat pump dryer takes 10kg loads and uses less energy than a vented dryer, so laundry costs you less." };
  const r = await run(() => productFirst, product(null));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.attempts, 2);
  assert.ok(r.meta.warnings.includes("opening_product_first"));
});

test("a hard problem (model code in the copy) still fails", async () => {
  const bad = { ...COPY(false, ""), npr_heading: "Haier HDHP10DB1 Heat Pump Dryer – Black" };
  const r = await run(() => bad, product(null));
  assert.strictEqual(r.httpStatus, 502);
});

test("evidence quotes never reach Simple, and review_notes are present when switched on", async () => {
  const withNotes = { ...COPY(true, `(1) ${FOOTNOTE}`), review_notes: ["npr_long_copy: removed a battery claim, no source."] };
  const r = await run(() => withNotes, product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.ok(!("disclaimer_evidence" in r.body.copy) && !("disclaimer_evidence" in r.body));
  assert.deepStrictEqual(r.body.review_notes, ["npr_long_copy: removed a battery claim, no source."]);
  assert.deepStrictEqual(Object.keys(r.body.copy), ["npr_heading", "npr_short_copy", "npr_long_copy", "disclaimers"]);
});

test("no changes made: review_notes is an empty list", async () => {
  const r = await run(() => COPY(false, ""), product(null));
  assert.deepStrictEqual(r.body.review_notes, []);
});

test("a disclaimer drafted from the source, with its passage, is returned", async () => {
  const drafted = "(1) Independently tested against bacteria using the Allergy Care cycle.";
  const r = await run(() => COPY(true, drafted, [{ n: 1, quote: FOOTNOTE }]), product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.body.copy.disclaimers, drafted);
  assert.strictEqual(r.meta.attempts, 1);
});

test("a statistic with no tag and no source is returned with a review note", async () => {
  const stat = { ...COPY(false, "") };
  stat.npr_long_copy = stat.npr_long_copy.replace("school uniforms.", "school uniforms, cutting energy use by 40%.");
  const r = await run(() => stat, product(null));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.attempts, 2);
  assert.ok(r.meta.warnings.includes("stat_no_disclaimer"));
  assert.ok(r.body.review_notes.some((n) => n.startsWith("npr_long_copy: states a statistic")));
});

test("no attachments: the official source is searched, read, and flows into the prompt", async () => {
  const zorbo = { ...product(null), brand: { name: "Zorbo" } };
  const sc = (n) => (n === 1 ? { product_page: null, spec_sheet: `${docBase}/spec.pdf`, manual: null, other: [] } : COPY(true, `(1) ${SPEC_LINE}`, [{ n: 1, quote: SPEC_LINE }]));
  const r = await run(sc, zorbo);
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.sources.used, 1);
  assert.ok(lastPrompt.includes("official manufacturer PDF"));
  assert.strictEqual(r.body.copy.disclaimers, `(1) ${SPEC_LINE}`);
});

test("source search finds nothing: the copy is still written, with no disclaimers", async () => {
  const zorbo = { ...product(null), brand: { name: "Zorbo" } };
  const sc = (n) => (n === 1 ? { product_page: null, spec_sheet: null, manual: null, other: [] } : COPY(false, ""));
  const r = await run(sc, zorbo);
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.sources.skipped, "nothing_found");
  assert.strictEqual(r.body.copy.disclaimers, "");
});

test("attachments take priority: no source search when a Nexus document was read", async () => {
  const zorbo = { ...product(`${docBase}/a/nprFile.pdf`), brand: { name: "Zorbo" } };
  const r = await run(() => COPY(true, `(1) ${FOOTNOTE}`), zorbo);
  assert.strictEqual(r.httpStatus, 200);
  assert.ok(!r.meta.sources);
});

// ---- The service adds the tags -----------------------------------------------
const CLAIM = "The Allergy Care cycle removes more bacteria with every load, which is handy for bedding and school uniforms.";

test("tagDisclaimers puts the tag at the end of the claim sentence, before the full stop", () => {
  const obj = { ...COPY(false, `(1) ${FOOTNOTE}`, [{ n: 1, claim: CLAIM, quote: FOOTNOTE }]) };
  const out = tagDisclaimers(obj);
  assert.ok(out.npr_long_copy.includes("school uniforms <sup>1</sup>."));
  assert.strictEqual(out.disclaimers, `(1) ${FOOTNOTE}`);
});

test("tagDisclaimers numbers disclaimers in the order they appear in the copy", () => {
  const first = "Waiting days for a load of towels to dry on the line gets old fast, especially in winter.";
  const obj = COPY(false, "(1) Second text.\n(2) First text.", [
    { n: 1, claim: CLAIM, quote: "q1" },
    { n: 2, claim: first, quote: "q2" },
  ]);
  const out = tagDisclaimers(obj);
  assert.ok(out.npr_long_copy.indexOf("<sup>1</sup>") < out.npr_long_copy.indexOf("<sup>2</sup>"));
  assert.strictEqual(out.disclaimers, "(1) First text.\n(2) Second text.");
  assert.deepStrictEqual(out.disclaimer_evidence.map((e) => [e.n, e.quote]), [[2, "q1"], [1, "q2"]]);
});

test("tagDisclaimers leaves the reply alone when the claim sentence is not in the copy", () => {
  const obj = COPY(false, `(1) ${FOOTNOTE}`, [{ n: 1, claim: "A sentence that is not there.", quote: FOOTNOTE }]);
  assert.strictEqual(tagDisclaimers(obj), obj);
});

test("end to end: the model gives the claim sentence, the service adds the tag", async () => {
  const sc = () => COPY(false, `(1) ${FOOTNOTE}`, [{ n: 1, claim: CLAIM, quote: FOOTNOTE }]);
  const r = await run(sc, product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.attempts, 1);
  assert.ok(r.body.copy.npr_long_copy.includes("uniforms <sup>1</sup>."));
  assert.strictEqual(r.body.copy.disclaimers, `(1) ${FOOTNOTE}`);
});

test("tagDisclaimers: a claim that ends with a full stop but the sentence goes on is still tagged at the sentence end", () => {
  const obj = COPY(false, `(1) ${FOOTNOTE}`, [{ n: 1, claim: "The Allergy Care cycle removes more bacteria with every load.", quote: FOOTNOTE }]);
  const out = tagDisclaimers(obj);
  assert.ok(out.npr_long_copy.includes("school uniforms <sup>1</sup>."), out.npr_long_copy.slice(0, 400));
});

test("tagDisclaimers: tags the model wrote itself are replaced, so none sit after a full stop", () => {
  const obj = COPY(false, `(1) ${FOOTNOTE}`, [{ n: 1, claim: CLAIM, quote: FOOTNOTE }]);
  obj.npr_long_copy = obj.npr_long_copy.replace("school uniforms.", "school uniforms.<sup>1</sup>");
  const out = tagDisclaimers(obj);
  assert.ok(out.npr_long_copy.includes("school uniforms <sup>1</sup>."));
  assert.strictEqual((out.npr_long_copy.match(/<sup>/g) || []).length, 1);
});

test("tagDisclaimers: a lightly paraphrased claim finds its sentence", () => {
  const obj = COPY(false, `(1) ${FOOTNOTE}`, [{ n: 1, claim: "The Allergy Care cycle removes more bacteria with each load, handy for bedding and uniforms", quote: FOOTNOTE }]);
  const out = tagDisclaimers(obj);
  assert.ok(out.npr_long_copy.includes("school uniforms <sup>1</sup>."));
});

test("tagDisclaimers: two disclaimers on one sentence give consecutive tags before the full stop", () => {
  const obj = COPY(false, "(1) One.\n(2) Two.", [
    { n: 1, claim: CLAIM, quote: "q1" },
    { n: 2, claim: CLAIM, quote: "q2" },
  ]);
  const out = tagDisclaimers(obj);
  assert.ok(out.npr_long_copy.includes("school uniforms <sup>1</sup> <sup>2</sup>."));
});

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
const MOCK_PORT = 18000 + Math.floor(Math.random() * 1000);
process.env.PERPLEXITY_URL = `http://localhost:${MOCK_PORT}/chat/completions`;
delete process.env.PERPLEXITY_API_MODE;

const test = require("node:test");
const assert = require("node:assert");
const { generateCopy } = require("./generate");

const PDF = fs.readFileSync(path.join(__dirname, "tests", "fixtures", "brochure.pdf"));
const FOOTNOTE = "Independently tested to eliminate greater than 99.9% of staphylococcus aureus and E. coli using the Allergy Care cycle.";

const COPY = (sup, disclaimers) => ({
  npr_heading: "Haier 10kg Heat Pump Dryer – Black",
  npr_short_copy: "Wet washing hanging around for days is no fun. This Haier heat pump dryer takes 10kg loads and uses less energy than a vented dryer, so everyday laundry costs you less.",
  npr_long_copy: [
    "Waiting days for a load of towels to dry on the line gets old fast, especially in winter. This Haier heat pump dryer takes loads up to 10kg, so you'll get through the family wash in fewer cycles and have clean clothes ready when you need them. It's built for busy households that want gentle drying without the running costs of a vented model.",
    `The Allergy Care cycle removes more bacteria with every load${sup ? " <sup>1</sup>" : ""}, which is handy for bedding and school uniforms. Heat pump technology dries at a lower temperature, which is kinder to your clothes and helps keep energy use down. That means woollens and delicates come out soft instead of shrunken, and your power bill won't jump when the dryer runs most days.`,
    "The control panel is easy to read, so you can pick a program in seconds, even when you're juggling a basket and a toddler. Choose from a range of cycles for towels, cottons and delicates, and use the delay start to dry overnight when it suits you. There's no need to stand and watch the clock or check the load every half hour.",
    "Finished in black, this dryer fits neatly into most laundries and sits well beside a washing machine. It's backed by a two year warranty, and it suits anyone who wants dependable drying without a vent kit or a hole in the wall. If you're tired of racks of washing taking over the living room, this one is worth a look.",
  ].join("\n\n"),
  disclaimers,
});

let mock, scenario, lastPrompt, calls;
const docServer = http.createServer((req, res) => {
  if (req.url === "/a/nprFile.pdf") return res.writeHead(200).end(PDF);
  if (req.url === "/denied.pdf") return res.writeHead(403).end("no");
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
  categoryAttributes: { "Capacity (kg)": 10 },
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
  const r = await run(() => COPY(true, `<sup>1</sup> ${FOOTNOTE}`), product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.ok(lastPrompt.includes("DISCLAIMER SOURCES"));
  assert.ok(lastPrompt.includes("staphylococcus aureus"));
  assert.strictEqual(r.body.copy.disclaimers, `<sup>1</sup> ${FOOTNOTE}`);
  assert.ok(r.body.copy.npr_long_copy.includes(" <sup>1</sup>"));
  assert.strictEqual(r.meta.attempts, 1);
  assert.strictEqual(r.meta.documents[0].ok, true);
});

test("an invented footnote is rejected, then fixed on the retry", async () => {
  const r = await run((n) => (n === 1 ? COPY(true, "<sup>1</sup> Tested by an independent lab to remove 100% of all germs forever.") : COPY(true, `<sup>1</sup> ${FOOTNOTE}`)), product(`${docBase}/a/nprFile.pdf`));
  assert.strictEqual(r.httpStatus, 200);
  assert.strictEqual(r.meta.attempts, 2);
  assert.deepStrictEqual(r.meta.retriedBecause, ["disclaimer_untraceable"]);
  assert.strictEqual(r.body.copy.disclaimers, `<sup>1</sup> ${FOOTNOTE}`);
});

test("invented footnote twice: copy still returns, without disclaimers or tags", async () => {
  const r = await run(() => COPY(true, "<sup>1</sup> Tested by an independent lab to remove 100% of all germs forever."), product(`${docBase}/a/nprFile.pdf`));
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
  const r = await run(() => COPY(true, `<sup>1</sup> ${FOOTNOTE}`), product(null));
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

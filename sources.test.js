// sources.test.js
// Tests for the official-source route. A fake Perplexity and a fake manufacturer
// site run on localhost. No internet.   Run with:  npm test

const http = require("http");
const fs = require("fs");
const path = require("path");

const MOCK_PORT = 19000 + Math.floor(Math.random() * 900);
process.env.PERPLEXITY_URL = `http://127.0.0.1:${MOCK_PORT}/chat/completions`;
delete process.env.PERPLEXITY_API_MODE;

const test = require("node:test");
const assert = require("node:assert");
const { findOfficialSources, shopifyUrl, domainsFor } = require("./sources");

const SPEC = fs.readFileSync(path.join(__dirname, "tests", "fixtures", "spec-with-model.pdf"));
const OTHER = fs.readFileSync(path.join(__dirname, "tests", "fixtures", "brochure.pdf")); // no model number in it

let site, base, pplx, answer, seenFilter;
const searchReply = (o) => ({
  choices: [{ message: { content: JSON.stringify(o) }, finish_reason: "stop" }],
  search_results: [],
  usage: { prompt_tokens: 100, completion_tokens: 50, cost: { total_cost: 0.003 } },
});

test.before(async () => {
  site = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/spec.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(SPEC);
    if (u === "/other.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(OTHER);
    if (u === "/page") {
      return res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<html><nav>Menu Shop Blog</nav><script>var x=1</script><p>Haier HDHP10DB1 dryer. Surface temperatures can be high.</p></html>");
    }
    if (u === "/page-other") return res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Haier HDHP10DB11 is a different dryer.</p>");
    if (u === "/products/haier-dryer") return res.writeHead(429, { "Retry-After": "60" }).end("slow down");
    if (u === "/products/haier-dryer.js") {
      return res.writeHead(200, { "Content-Type": "text/javascript" }).end(JSON.stringify({ title: "Haier HDHP10DB1 Dryer", description: "<p>Safe <b>CoolTouch</b> handles.</p>" }));
    }
    if (u === "/redir") return res.writeHead(302, { Location: "http://169.254.169.254/x" }).end();
    res.writeHead(404).end();
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
  pplx = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seenFilter = JSON.parse(b).search_domain_filter;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(searchReply(answer(base))));
    });
  });
  await new Promise((r) => pplx.listen(MOCK_PORT, "127.0.0.1", r));
});
test.after(() => {
  site.close();
  pplx.close();
});

const PRODUCT = { ean: "1", heading: "Haier 10kg Heat Pump Dryer", modelNo: "HDHP10DB1", brand: { name: "Haier" } };
const run = (reply, extra = {}) => {
  answer = reply;
  return findOfficialSources(PRODUCT, { apiKey: "k", domains: ["127.0.0.1"], allowHttp: true, ...extra });
};

test("a spec sheet that names the exact model is read and returned", async () => {
  const r = await run((b) => ({ product_page: null, spec_sheet: `${b}/spec.pdf`, manual: null, other: [] }));
  assert.strictEqual(r.used, 1);
  assert.ok(/independently tested/i.test(r.text));
  assert.ok(/official manufacturer PDF/.test(r.text));
  assert.strictEqual(r.costUsd, 0.003);
  assert.deepStrictEqual(seenFilter, ["127.0.0.1"], "search is limited to the brand domains");
});

test("a document that does not name the model is dropped", async () => {
  const r = await run((b) => ({ spec_sheet: `${b}/other.pdf` }));
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.skipped, "no_source_named_the_model");
  assert.strictEqual(r.report[0].reason, "model_not_found");
});

test("a page for a different model with a similar code is dropped", async () => {
  const r = await run((b) => ({ product_page: `${b}/page-other` }));
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.report[0].reason, "model_not_found");
});

test("a web page is read as text, without menus or scripts", async () => {
  const r = await run((b) => ({ product_page: `${b}/page` }));
  assert.strictEqual(r.used, 1);
  assert.ok(r.text.includes("Surface temperatures can be high"));
  assert.ok(!r.text.includes("var x"));
});

test("a blocked Shopify page falls back to its JSON version", async () => {
  const r = await run((b) => ({ product_page: `${b}/products/haier-dryer?variant=1` }));
  assert.strictEqual(r.used, 1);
  assert.strictEqual(r.report[0].kind, "shopify_json");
  assert.ok(r.text.includes("CoolTouch handles"));
});

test("URLs outside the brand domains are never fetched", async () => {
  const r = await run(() => ({ product_page: "https://evil.example.com/x", spec_sheet: "http://169.254.169.254/x.pdf" }));
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.skipped, "nothing_found");
  assert.ok(r.report.every((x) => x.reason === "not_an_official_https_url"));
});

test("a redirect to another host is refused", async () => {
  const r = await run((b) => ({ product_page: `${b}/redir` }));
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.report[0].reason, "host_not_allowed");
});

test("http links are refused unless the test switch is on", async () => {
  const r = await run((b) => ({ product_page: `${b}/page` }), { allowHttp: false });
  assert.strictEqual(r.used, 0);
});

test("a brand with no listed domains is skipped without calling Perplexity", async () => {
  answer = () => {
    throw new Error("should not be called");
  };
  const r = await findOfficialSources({ ...PRODUCT, brand: { name: "Unlisted" } }, { apiKey: "k" });
  assert.strictEqual(r.skipped, "no_domains_for_brand");
});

test("a Perplexity failure never throws", async () => {
  const r = await run(() => ({}), { searchTimeoutMs: 1, domains: ["127.0.0.1"] }).catch((e) => ({ threw: e }));
  assert.ok(!r.threw);
});

test("shopifyUrl and brand lookup", () => {
  assert.strictEqual(shopifyUrl("https://x.com/products/a-b?variant=1"), "https://x.com/products/a-b.js");
  assert.strictEqual(shopifyUrl("https://x.com/products/a-b.oembed"), "https://x.com/products/a-b.js");
  assert.strictEqual(shopifyUrl("https://x.com/collections/air-fryers"), null);
  assert.deepStrictEqual(domainsFor("Tefal"), ["tefal.com.au"]);
  assert.deepStrictEqual(domainsFor("GAF Control"), ["gafcontrol.com.au"]);
  assert.deepStrictEqual(domainsFor("Nobody"), []);
});

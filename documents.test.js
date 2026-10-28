// documents.test.js
// Free tests for documents.js. A tiny local web server stands in for Nexus.
// Run with:  npm test

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectAttachments, retrieveDocuments, checkUrl, extensionOf } = require("./documents");

const PDF = fs.readFileSync(path.join(__dirname, "tests", "fixtures", "brochure.pdf"));
const SCANNED = fs.readFileSync(path.join(__dirname, "tests", "fixtures", "scanned.pdf"));

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const p = req.url;
    if (p === "/a/nprFile.pdf" || p === "/a/nprFile") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(PDF);
    if (p === "/scanned.pdf") return res.writeHead(200).end(SCANNED);
    if (p === "/html") return res.writeHead(200).end("<html>login</html>");
    if (p === "/denied.pdf") return res.writeHead(403).end("no");
    if (p === "/gone.pdf") return res.writeHead(404).end("no");
    if (p === "/redir.pdf") return res.writeHead(302, { Location: "/a/nprFile.pdf" }).end();
    if (p === "/evil.pdf") return res.writeHead(302, { Location: "http://169.254.169.254/x.pdf" }).end();
    if (p === "/big.pdf") return res.writeHead(200).end(Buffer.alloc(2 * 1024 * 1024, 1));
    if (p === "/slow.pdf") return setTimeout(() => res.end(PDF), 3000);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const OPTS = { hosts: ["localhost"], allowHttp: true };
const prod = (...uris) => ({ productbrochures: uris.map((u, i) => ({ id: "h" + i, type: "ProductBrochure", uri: u })) });

test("collectAttachments gathers all four arrays, skips deleted and duplicates", () => {
  const list = collectAttachments({
    productbrochures: [{ id: "1", uri: "https://x/1.pdf" }, { id: "1b", uri: "https://x/1.pdf" }],
    productdocuments: [{ id: "2", uri: "https://x/2.pdf", deleted: "2025-01-01" }],
    productusermanuals: [{ id: "3", uri: "https://x/3.pdf" }],
    productwarranties: [{ id: "4" }],
  });
  assert.deepStrictEqual(list.map((a) => a.id), ["1", "3"]);
  assert.deepStrictEqual(collectAttachments(null), []);
});

test("URL rules: https only, allowlisted host only", () => {
  const o = { hosts: ["retailpath.com.au"], allowHttp: false };
  assert.ok(checkUrl("https://nartastaging.retailpath.com.au/NARTAStaging/ra/NPRFile/abc/nprFile.pdf", o).ok);
  assert.strictEqual(checkUrl("http://nartastaging.retailpath.com.au/x.pdf", o).reason, "not_https");
  assert.strictEqual(checkUrl("https://evil.com/x.pdf", o).reason, "host_not_allowed");
  assert.strictEqual(checkUrl("https://retailpath.com.au.evil.com/x.pdf", o).reason, "host_not_allowed");
  assert.strictEqual(checkUrl("https://169.254.169.254/x.pdf", o).reason, "host_not_allowed");
  assert.strictEqual(checkUrl("http://127.0.0.1:10225/x", o).reason, "not_https");
  assert.strictEqual(checkUrl("not a url", o).reason, "bad_url");
});

test("extension comes from the end of the path", () => {
  assert.strictEqual(extensionOf(new URL("https://h/NPRFile/abc/nprFile.PDF")), "pdf");
  assert.strictEqual(extensionOf(new URL("https://h/NPRFile/abc/nprFile.docx")), "docx");
  assert.strictEqual(extensionOf(new URL("https://h/NPRFile/abc/nprFile")), "");
});

test("a PDF is fetched and its text extracted, footnote included", async () => {
  const r = await retrieveDocuments(prod(`${base}/a/nprFile.pdf`), OPTS);
  assert.strictEqual(r.used, 1);
  assert.ok(r.text.includes("[Document 1: brochure"));
  assert.ok(/greater than 99\.9% of staphylococcus aureus/.test(r.text));
});

test("a URL with no extension is sniffed by its first bytes", async () => {
  const r = await retrieveDocuments(prod(`${base}/a/nprFile`), OPTS);
  assert.strictEqual(r.used, 1);
});

test("redirects are followed when the target is allowed", async () => {
  const r = await retrieveDocuments(prod(`${base}/redir.pdf`), OPTS);
  assert.strictEqual(r.used, 1);
});

test("a redirect to a host that is not allowed is refused", async () => {
  const r = await retrieveDocuments(prod(`${base}/evil.pdf`), OPTS);
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.report[0].reason, "host_not_allowed");
});

test("bad documents are skipped with a reason, never thrown", async () => {
  const cases = [
    ["/html", "not_pdf"],
    ["/scanned.pdf", "no_text"],
    ["/denied.pdf", "http_403"],
    ["/gone.pdf", "http_404"],
    ["/big.pdf", "too_large"],
  ];
  for (const [p, reason] of cases) {
    const r = await retrieveDocuments(prod(`${base}${p}`), { ...OPTS, maxBytes: 1024 * 1024 });
    assert.strictEqual(r.text, "", p);
    assert.strictEqual(r.report[0].reason, reason, p);
  }
});

test("a non-PDF extension is skipped without downloading", async () => {
  const r = await retrieveDocuments(prod(`${base}/manual.docx`), OPTS);
  assert.strictEqual(r.report[0].reason, "unsupported_type:docx");
});

test("a slow document hits the time limit and the others still come back", async () => {
  const r = await retrieveDocuments(prod(`${base}/slow.pdf`, `${base}/a/nprFile.pdf`), { ...OPTS, docTimeoutMs: 500 });
  assert.strictEqual(r.report[0].reason, "timeout");
  assert.strictEqual(r.used, 1);
});

test("localhost URIs from the old test data are refused by default", async () => {
  const r = await retrieveDocuments(prod("http://127.0.0.1:10225/cgi-bin/WebObjects/NARTAStaging.woa/ra/NPRFile/abc/nprFile"));
  assert.strictEqual(r.report[0].reason, "not_https");
});

test("long documents keep the start and the end", async () => {
  const r = await retrieveDocuments(prod(`${base}/a/nprFile.pdf`), { ...OPTS, maxCharsPerDoc: 100 });
  assert.ok(r.text.includes("[...]"));
});

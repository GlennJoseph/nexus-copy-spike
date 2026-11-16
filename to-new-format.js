// to-new-format.js
//
// Makes a copy of tests/payloads/ in Nexus's NEW attachment format (16 Nov 2026):
//   productbrochures      -> pdfProductBrochures
//   productdocuments      -> pdfProductDocuments
//   productusermanuals    -> pdfProductUserManuals
//   productwarranties     -> pdfProductWarranties
//   http://host/...       -> https://host:443/...
// Only the attachment fields are changed, because that is all the screenshots show.
// The new files go to tests/payloads-new/ and the old ones are not touched.
//
//   node to-new-format.js
//   PAYLOAD_DIR=tests/payloads-new node run-tests.js

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "tests", "payloads");
const DEST = path.join(__dirname, "tests", "payloads-new");
const RENAME = {
  productbrochures: "pdfProductBrochures",
  productdocuments: "pdfProductDocuments",
  productusermanuals: "pdfProductUserManuals",
  productwarranties: "pdfProductWarranties",
};

const newUri = (uri) => {
  try {
    const u = new URL(uri);
    u.protocol = "https:";
    return `https://${u.hostname}:443${u.pathname}${u.search}`;
  } catch (e) {
    return uri;
  }
};

function convert(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (RENAME[k]) {
      out[RENAME[k]] = (Array.isArray(v) ? v : []).map((a) => (a && a.uri ? { ...a, uri: newUri(a.uri) } : a));
    } else out[k] = v;
  }
  return out;
}

fs.mkdirSync(DEST, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".json"))) {
  const p = JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8"));
  fs.writeFileSync(path.join(DEST, f), JSON.stringify(convert(p), null, 2));
  n++;
}
console.log(`Wrote ${n} payloads in the new format to tests/payloads-new/`);

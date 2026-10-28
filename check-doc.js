// check-doc.js
//
// Tries one attachment URL exactly the way the service would, from THIS machine.
//
//   node check-doc.js "https://nartastaging.retailpath.com.au/NARTAStaging/ra/NPRFile/<hash>/nprFile.pdf"
//
// Prints whether the file could be fetched and read, and the lines that look
// like footnotes. If it fails with http_401 / http_403 the URL needs a login
// and Simple must be asked how Camel should authenticate.
// Note: this runs from your machine, not from Cloud Run. Run the same check
// from Cloud Run (see the notes) before relying on it.

const { retrieveDocuments } = require("./documents");

async function main() {
  const uri = process.argv[2];
  if (!uri) {
    console.error('Usage: node check-doc.js "<attachment url>"');
    process.exit(2);
  }
  const r = await retrieveDocuments({ productbrochures: [{ id: "test", uri }] });
  const d = r.report[0] || {};
  console.log(d.ok ? "OK" : `FAILED: ${d.reason}`);
  console.log(JSON.stringify(d));
  if (!d.ok) process.exit(1);

  const hints = /(tested|based on|compared|independent|accredited|certified|results|measured|up to|\bvs\b|according)/i;
  const lines = r.text.split("\n").filter((l) => hints.test(l)).slice(0, 15);
  console.log(`\nLines that look like footnotes (${lines.length} shown):`);
  for (const l of lines) console.log("  -", l.trim().slice(0, 160));
  console.log(`\nFirst 400 characters of text:\n${r.text.slice(0, 400)}`);
}
main();

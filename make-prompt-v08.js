// make-prompt-v08.js
// Creates prompts/v0.8/system.md from prompts/v0.7/system.md.
//
// What changes (MM feedback from Shikha's testing notes, 17 Nov):
//  - the first time the product is named in the short copy, and again in the long copy, it is the
//    full product name from npr_heading (without the colour or finish)
//  - the same product name is used in the heading, short copy and long copy
//  - one self-check line for this
//  - v08b: the full name counts toward the short copy's 50 words (aim for 40 to 45)
//
// Not in this version (waiting for MM's naming document): brand in headings, category heading
// formats such as the air conditioner "C2.6kW H3.6kW" format.
//
// Run from the repo root:  node make-prompt-v08.js
// If a line is not found it prints a WARNING with the change to make by hand.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "prompts", "v0.7", "system.md");
const dstDir = path.join(__dirname, "prompts", "v0.8");
let t = fs.readFileSync(src, "utf8");

const RULE =
  '- Name the product in full the first time it appears in the short copy, and again the first time it appears in the long copy. Write "This" followed by the full product name exactly as it is in npr_heading, without the colour or finish (for example "This Tefal YumMeal Multicooker Air Fryer", "This Haier 9kg 600 Series MultiWash"). Do not shorten, reorder or reword it on that first mention (not "This Tefal YumMeal", "This mirrorless camera", "This split system"). Put it in the sentence that gives the product\'s answer, not in the opening problem sentence. After that, you may call it "this" and the product type (for example "this air fryer"). The heading, short copy and long copy must all use the same product name.';

function after(re, addition, what) {
  const m = t.match(re);
  if (!m) {
    console.warn(`WARNING: ${what} not found in v0.7. Add this line by hand in prompts/v0.8/system.md:\n  ${addition}\n`);
    return;
  }
  const at = m.index + m[0].length;
  const eol = t[at] === "\r" ? "\r\n" : "\n"; // v0.7 has mixed line endings, keep each line's own
  t = t.slice(0, at) + eol + addition + t.slice(at);
}

after(/^- Always write the full product name\..*$/m, RULE, "the full product name rule");
after(
  /^- Open with the everyday problem in one short sentence, then give the product's answer\..*$/m,
  "- The first time the product is named here, use the full product name from npr_heading (see CORE RULES).",
  "the short copy opening line"
);
after(
  /^- Maximum 50 words and 500 characters\..*$/m,
  "- The full product name counts toward the 50 words. Aim for 40 to 45 words in total so the full name fits, and keep the problem sentence short.",
  "the short copy word limit line"
);
after(
  /^- Length: 200 to 300 words is required\..*$/m,
  "- The first time the product is named here, use the full product name from npr_heading (see CORE RULES). Do not shorten it, even though the short copy already used it.",
  "the long copy length line"
);
after(
  /^- Every benefit names a real everyday situation.*$/m,
  "- The first mention of the product in the short copy, and in the long copy, is the full product name from npr_heading, without the colour or finish. The same product name is used in the heading, short copy and long copy",
  "the last self-check line"
);

fs.mkdirSync(dstDir, { recursive: true });
fs.writeFileSync(path.join(dstDir, "system.md"), t);
console.log("Wrote prompts/v0.8/system.md");

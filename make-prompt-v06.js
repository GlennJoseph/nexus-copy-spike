// make-prompt-v06.js
// Creates prompts/v0.6/system.md from prompts/v0.5/system.md with the NPR
// disclaimer format: "(1) text" lines, <sup>N</sup> at the end of the sentence
// before the full stop. Changes only the "### disclaimers" section and the
// matching self-check line. Run from the repo root:  node make-prompt-v06.js
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "prompts", "v0.5", "system.md");
const dstDir = path.join(__dirname, "prompts", "v0.6");
let t = fs.readFileSync(src, "utf8");

const start = t.indexOf("### disclaimers");
if (start < 0) throw new Error('No "### disclaimers" heading in v0.5');
const rest = t.slice(start);
const m = rest.match(/\n(?:\*\*\*\s*\n)?\s*## /);
if (!m) throw new Error("No heading after the disclaimers section in v0.5");
const next = start + m.index;

const section = `### disclaimers
A disclaimer is a footnote that backs up a claim: a test result, a comparison, or a performance or efficiency figure ("independently tested to...", "based on...", "compared to...").

Look for a section called DISCLAIMER SOURCES in the user message.
- If there is no such section, return "" and add no <sup> tags anywhere.
- If there is, find footnotes in those documents that back up claims you actually make in the copy. Use only those. If none fit, return "" and add no <sup> tags.
- Copy each footnote's wording exactly as it is written in the document. Fix only broken line breaks and spacing. Never reword, shorten, combine or invent a footnote.
- In npr_long_copy, put the tag at the end of the sentence that makes the claim, with a space before it and before the full stop: "...with fade-free power <sup>1</sup>." Number the tags from 1 in order of first use. If one footnote backs up two claims, reuse its number.
- Write disclaimers as one line per footnote, in this exact form, with a single \\n between lines. Plain numbers in brackets, no <sup> tags in this field:
(1) Footnote text.
(2) Footnote text.
- Use at most 5 footnotes.
- Never use <sup> tags in npr_short_copy.
`;

t = t.slice(0, start) + section + t.slice(next);

const checkRe = /^- <sup> tags only where.*$/m;
if (!checkRe.test(t)) throw new Error("Self-check line about <sup> tags not found in v0.5");
t = t.replace(
  checkRe,
  '- <sup> tags only in npr_long_copy, at the end of the sentence before the full stop, only where a document footnote backs up the claim. Disclaimers are "(1) text" lines, each footnote copied exactly, numbered in order, and "" when there is no DISCLAIMER SOURCES section'
);

fs.mkdirSync(dstDir, { recursive: true });
fs.writeFileSync(path.join(dstDir, "system.md"), t);
console.log("Wrote prompts/v0.6/system.md");

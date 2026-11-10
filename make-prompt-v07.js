// make-prompt-v07.js
// Creates prompts/v0.7/system.md from prompts/v0.6/system.md.
//
// What changes:
//  - the "### disclaimers" section: disclaimers may be drafted from the sources, each with its
//    exact source passage (disclaimer_evidence); unsupported claims are narrowed or removed and
//    listed in review_notes
//  - the short copy rule: no claim that needs a disclaimer
//  - the output keys and the example JSON line (two new keys)
//  - the self-check line about disclaimers
//
// Run from the repo root:  node make-prompt-v07.js
// It stops with an error if the disclaimers section is missing. If another line is not found it
// prints a WARNING with the change to make by hand.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "prompts", "v0.6", "system.md");
const dstDir = path.join(__dirname, "prompts", "v0.7");
let t = fs.readFileSync(src, "utf8");

const start = t.indexOf("### disclaimers");
if (start < 0) throw new Error('No "### disclaimers" heading in v0.6');
const rest = t.slice(start);
const m = rest.match(/\n(?:\*\*\*\s*\n)?\s*## /);
if (!m) throw new Error("No heading after the disclaimers section in v0.6");
const next = start + m.index;

const section = `### disclaimers
A disclaimer qualifies a claim that states a performance statistic, percentage, test result or certification (for example "removes 99.9% of dust", "heats in 90 seconds", "Woolmark certified"). Qualitative claims described in everyday words (for example "helps prevent overheating", "soft fabric", "easy to clean", "quiet") need no disclaimer. Keep them. Most products need few disclaimers or none.

Look for a section called DISCLAIMER SOURCES in the user message.
- If there is no such section, return "" and add no <sup> tags anywhere. Never write a disclaimer from your own knowledge.
- If there is, you may copy a footnote exactly as written, or write a short qualification in your own words, but only from what the sources say. Every figure, standard, test condition and manufacturer statement in a disclaimer must appear in the source passage you quote for it. Never add a fact, number, test or condition the sources do not state. Never write a general caveat that the sources do not contain. Do not say "tested", "certified", "accredited" or "independent" unless the passage says it.
- Do not write <sup> tags yourself. For every disclaimer, add an entry to disclaimer_evidence: {"n": 1, "claim": "...", "quote": "..."}. claim is the exact sentence from your npr_long_copy that the disclaimer qualifies, copied word for word. quote is the exact passage from DISCLAIMER SOURCES, copied word for word, not a paraphrase (fix only broken line breaks and spacing). The service adds the tag at the end of the claim sentence and numbers the disclaimers in order of use.
- Keep a manufacturer's own qualification. If a source contains a disclaimer, note or footnote about a term, feature or claim that your copy or the product name uses (for example the product name says "Silent" and the source says noise may be heard at higher speeds), include it as a disclaimer. If the term is only in the product name, mention it in npr_long_copy (for example "the Schweigen Silent range") so the disclaimer has a sentence to attach to.
- Do not use general legal notices as disclaimers (liability, specifications may change, pictures are illustrative).
- Write disclaimers as one line per footnote, in this exact form, with a single \\n between lines. Plain numbers in brackets, no <sup> tags in this field:
(1) Disclaimer text.
(2) Disclaimer text.
- Use at most 5 disclaimers.
- If a claim needs a qualification but the sources do not support one, do not keep the claim. Narrow it to what the product data supports, or remove it, and add a note to review_notes. A disclaimer must never be used to keep an unsupported claim.
- review_notes is a list of short plain sentences, each starting with the field name, for example "npr_long_copy: removed the claim about battery life, no source supports it." Add a note ONLY when you removed or narrowed a statistic, test result or certification claim from the product data because no source supports a disclaimer for it. Do not add notes about wording choices, details you left out, rounding, or anything else. Otherwise return [].
- Never put a disclaimer claim in npr_short_copy, and keep any claim that needs a disclaimer out of npr_short_copy. Say it generally or leave it out.
`;
t = t.slice(0, start) + section + t.slice(next);

function swap(re, replacement, what) {
  if (!re.test(t)) {
    console.warn(`WARNING: ${what} not found in v0.6. Change it by hand in prompts/v0.7/system.md:\n  ${replacement}\n`);
    return;
  }
  t = t.replace(re, replacement);
}

swap(
  /^- Do not use disclaimer tags in the short copy\.[ \t]*$/m,
  "- Do not use disclaimer tags in the short copy. Keep it general and feature-led. Do not put a percentage, test result or certification claim in it.",
  "the short copy disclaimer line"
);
swap(
  /^- Use exactly these four keys:.*$/m,
  "- Use exactly these keys: npr_heading, npr_short_copy, npr_long_copy, disclaimers, disclaimer_evidence, review_notes.",
  "the output keys line"
);
swap(
  /^\{"npr_heading".*\}[ \t]*$/m,
  '{"npr_heading":"Brand Product Name – Colour","npr_short_copy":"...","npr_long_copy":"Paragraph one.\\n\\nParagraph two.\\n\\nParagraph three.\\n\\nParagraph four.","disclaimers":"","disclaimer_evidence":[],"review_notes":[]}',
  "the example JSON line"
);
swap(
  /^- <sup> tags only in npr_long_copy.*$/m,
  '- No <sup> tags written by me. Each disclaimer is a "(1) text" line with its claim sentence and exact source passage in disclaimer_evidence, and only where DISCLAIMER SOURCES support the qualification. No claim that needs a disclaimer in the short copy. Unsupported claims are narrowed or removed and listed in review_notes',
  "the disclaimers self-check line"
);

fs.mkdirSync(dstDir, { recursive: true });
fs.writeFileSync(path.join(dstDir, "system.md"), t);
console.log("Wrote prompts/v0.7/system.md");

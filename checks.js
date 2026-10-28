// checks.js
//
// Everything in here looks at data. Nothing in here calls an API.
//
//   validateInput       is the Nexus payload usable?
//   preparePayload      clean the payload before it goes to Perplexity
//   extractJson         pull the JSON object out of the model's reply
//   checkCopy           test the generated copy against the NPR rules
//   findRetailerSources spot retailer sites in Perplexity's search results
//
// checkCopy returns two lists:
//   errors   = blocking. generate.js retries once, then returns an error.
//   warnings = logged and shown in test runs only. Never block a response.

// ---------------------------------------------------------------------
// Limits. heading/short/long chars are the confirmed Nexus limits.
// ---------------------------------------------------------------------
const LIMITS = {
  headingChars: 100,
  shortChars: 500,
  shortWords: 50,
  longChars: 2000,
  longWordsMax: 300,
  longWordsMin: 200, // warning only
  paragraphsMin: 4,
  paragraphsMax: 5,
  disclaimersChars: 10000, // proposed safety ceiling, NOT yet agreed with MM
};

const FIELDS = ["npr_heading", "npr_short_copy", "npr_long_copy", "disclaimers"];

// MM's banned word list. Whole words only, so "rangehood" does not trip "hood".
const BANNED_WORDS = [
  ["guaranteed", /\bguaranteed\b/i],
  ["engineered", /\bengineered\b/i],
  ["synchronises", /\bsynchronis(?:e|es|ed|ing)\b/i],
  ["usability", /\busability\b/i],
  ["elevate", /\belevat(?:e|es|ed|ing)\b/i],
  ["array", /\barrays?\b/i],
  ["expansive", /\bexpansive\b/i],
  ["aesthetic", /\baesthetics?\b/i],
  ["hood", /\bhood\b/i],
  ["extended", /\bextended\b/i],
  ["television", /\btelevisions?\b/i],
  ["consolidates", /\bconsolidat(?:e|es|ed|ing)\b/i],
];

// Banned unless the product data itself uses the phrase.
const BANNED_CLAIMS = [
  ["world's best/first/most/leading", /world['’]s (?:best|first|most|leading)/i],
  ["best in class", /best[- ]in[- ]class/i],
  ["class-leading", /class[- ]leading/i],
  ["revolutionary", /\brevolutionary\b/i],
  ["the most powerful", /the most powerful/i],
  ["the best", /\bthe best\b/i],
];

const US_SPELLINGS =
  /\b(?:optimiz\w*|recogniz\w*|organiz\w*|personaliz\w*|customiz\w*|color\w*|flavor\w*|favorite)\b/i;

// Copy must state facts directly, never talk about where they came from
// ("mentioned in the product information", "the listing says", "according to").
const SOURCE_TALK =
  /\b(?:product (?:information|data|details|listing|description)|(?:mentioned|listed|stated|noted|described) (?:in|on|by)|according to|as (?:listed|stated|mentioned|noted)|the (?:listing|manufacturer'?s? (?:information|data)|source) (?:says|states|lists|shows))\b/i;

const CONTRACTION =
  /\b(?:it|you|that|there|they|we|here|what|let)['’](?:s|ll|re|ve|d)\b|\b(?:don|doesn|didn|isn|aren|wasn|weren|can|won|wouldn|couldn|shouldn|hasn|haven)['’]t\b/gi;

// Best-effort list of retailer hostnames (substring match). Add more as found.
const RETAILER_HINTS = [
  "harveynorman",
  "thegoodguys",
  "jbhifi",
  "binglee",
  "appliancesonline",
  "winnings",
  "homeclearance",
  "signatureappliances",
  "powerland",
  "appliancegroup",
  "commercialappliances",
  "appliancecentral",
];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function wordCount(s) {
  const t = String(s || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------
// Returns a list of problems. Empty list = usable.
function validateInput(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    return ["request body (expected one JSON object)"];
  }
  const hasText = (v) =>
    (typeof v === "string" || typeof v === "number") && String(v).trim() !== "";
  const missing = [];
  if (!hasText(p.ean)) missing.push("ean");
  if (!hasText(p.heading)) missing.push("heading");
  if (!hasText(p.modelNo)) missing.push("modelNo");
  if (!hasText(p.brand && p.brand.name)) missing.push("brand.name");
  if (!hasText(p.defaultdisplaycategory && p.defaultdisplaycategory.name)) {
    missing.push("defaultdisplaycategory.name");
  }
  if (
    !p.categoryAttributes ||
    typeof p.categoryAttributes !== "object" ||
    Array.isArray(p.categoryAttributes)
  ) {
    missing.push("categoryAttributes");
  }
  return missing;
}

// Phase 4 (documents) will read the attachment lists BEFORE they are removed here.
const ATTACHMENT_KEYS = [
  "productbrochures",
  "productdocuments",
  "productusermanuals",
  "productwarranties",
];

// Returns a cleaned copy: attachment lists removed, strings trimmed (including
// the stray tabs in some attribute names), null and empty values dropped.
function preparePayload(raw) {
  const clean = (v) => {
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const c = clean(val);
        if (c === null || c === undefined || c === "") continue;
        out[k.trim()] = c;
      }
      return out;
    }
    return v;
  };
  const copy = clean(raw);
  for (const k of ATTACHMENT_KEYS) delete copy[k];
  return copy;
}

// ---------------------------------------------------------------------
// Model reply
// ---------------------------------------------------------------------
function extractJson(text) {
  if (typeof text !== "string") return null;
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch (e) {
    /* fall through */
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (e) {
      /* fall through */
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Disclaimers must come from the product's documents
// ---------------------------------------------------------------------
const normText = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// True when the disclaimer wording is found in the document text. PDF text
// extraction can break lines and hyphenate words, so a near-exact match is fine:
// 85% of the disclaimer's three-word runs must appear in the document.
function isTraceable(disclaimer, docNorm) {
  const d = normText(disclaimer);
  if (!d) return false;
  if (docNorm.includes(d)) return true;
  const words = d.split(" ");
  if (words.length < 4) return false;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 3 <= words.length; i++) {
    total++;
    if (docNorm.includes(words.slice(i, i + 3).join(" "))) hit++;
  }
  return total > 0 && hit / total >= 0.85;
}

// "<sup>1</sup> Footnote text" lines. Returns { entries, problems }.
function parseDisclaimers(text) {
  const entries = [];
  const problems = [];
  const lines = String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^<sup>\s*(\d+)\s*<\/sup>\s+(\S.*)$/);
    if (!m) {
      problems.push(`Line "${line.slice(0, 40)}" is not in the form: <sup>1</sup> Footnote text`);
      continue;
    }
    entries.push({ n: Number(m[1]), text: m[2] });
  }
  return { entries, problems };
}

// ---------------------------------------------------------------------
// Short and long copy must not open with the same sentence
// ---------------------------------------------------------------------
function firstSentenceWords(text) {
  const first = String(text).trim().split(/(?<=[.!?])\s/)[0] || "";
  return first.toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Returns true when the long copy's first sentence repeats the short copy's:
// either 8+ opening words in a row match, or 60%+ of the words are shared.
function sameOpening(short, long) {
  const a = firstSentenceWords(short);
  const b = firstSentenceWords(long);
  if (a.length < 6 || b.length < 6) return false;
  let lead = 0;
  while (lead < a.length && lead < b.length && a[lead] === b[lead]) lead++;
  if (lead >= 8) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / new Set([...sa, ...sb]).size >= 0.6;
}

// ---------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------
// copy      = the parsed JSON object from the model
// product   = the cleaned payload (for modelNo, brand, finish)
// sourceText= JSON text of the cleaned payload (so a banned claim that the
//             product data itself makes is allowed)
function checkCopy(copy, { product = {}, sourceText = "", documentText = "" } = {}) {
  const errors = [];
  const warnings = [];
  const err = (check, message) => errors.push({ check, message });
  const warn = (check, message) => warnings.push({ check, message });

  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    err("schema", "Return one JSON object with the four fields.");
    return { errors, warnings, stats: {} };
  }
  for (const f of FIELDS) {
    if (typeof copy[f] !== "string") err("schema", `${f} must be a string (use "" if empty).`);
  }
  if (errors.length) return { errors, warnings, stats: {} };

  const heading = copy.npr_heading.trim();
  const short = copy.npr_short_copy.trim();
  const long = copy.npr_long_copy.trim();
  const disclaimers = copy.disclaimers.trim();

  if (!heading) err("empty", "npr_heading must not be empty.");
  if (!short) err("empty", "npr_short_copy must not be empty.");
  if (!long) err("empty", "npr_long_copy must not be empty.");

  const paragraphs = long.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const stats = {
    headingChars: heading.length,
    shortWords: wordCount(short),
    shortChars: short.length,
    longWords: wordCount(long),
    longChars: long.length,
    paragraphs: paragraphs.length,
  };

  // Length limits
  if (stats.headingChars > LIMITS.headingChars) {
    err("heading_length", `npr_heading is ${stats.headingChars} characters. Maximum is ${LIMITS.headingChars}.`);
  }
  if (stats.shortChars > LIMITS.shortChars) {
    err("short_chars", `npr_short_copy is ${stats.shortChars} characters. Maximum is ${LIMITS.shortChars}.`);
  }
  if (stats.shortWords > LIMITS.shortWords) {
    err("short_words", `npr_short_copy is ${stats.shortWords} words. Maximum is ${LIMITS.shortWords}.`);
  }
  if (stats.longChars > LIMITS.longChars) {
    err("long_chars", `npr_long_copy is ${stats.longChars} characters. Maximum is ${LIMITS.longChars}. Shorten it.`);
  }
  if (stats.longWords > LIMITS.longWordsMax) {
    err("long_words", `npr_long_copy is ${stats.longWords} words. Maximum is ${LIMITS.longWordsMax}. Shorten it.`);
  }
  if (long && stats.longWords < LIMITS.longWordsMin) {
    warn("long_words_low", `npr_long_copy is ${stats.longWords} words. Target is ${LIMITS.longWordsMin} or more.`);
  }
  if (long && (stats.paragraphs < LIMITS.paragraphsMin || stats.paragraphs > LIMITS.paragraphsMax)) {
    err(
      "paragraphs",
      `npr_long_copy has ${stats.paragraphs} paragraphs. It must have ${LIMITS.paragraphsMin} (five at most), separated by a blank line.`
    );
  }
  if (disclaimers.length > LIMITS.disclaimersChars) {
    err("disclaimers_length", `disclaimers is ${disclaimers.length} characters. Maximum is ${LIMITS.disclaimersChars}.`);
  }

  const all = [heading, short, long, disclaimers].join("\n");

  // Model code must never appear in the copy
  const modelNo = product.modelNo ? String(product.modelNo).trim() : "";
  if (modelNo.length >= 3) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(modelNo)}(?![A-Za-z0-9])`, "i");
    if (re.test(all)) {
      err("model_code", `The reply contains the model code "${modelNo}". Remove it everywhere and use the product name.`);
    }
  }

  // Style rules
  if (all.includes("—")) {
    err("em_dash", "The reply contains an em dash. Use a comma or split the sentence.");
  }
  if (/\\n/.test(all)) {
    err("escaped_newline", "The text contains a literal backslash-n. Use real paragraph breaks.");
  }
  if (/\[\d+\]/.test(all)) {
    err("citation_marker", "The text contains citation markers like [1]. Remove them.");
  }
  if (/\*\*|^#{1,6}\s/m.test(all)) {
    err("markdown", "The text contains markdown (** or #). Use plain text only.");
  }
  for (const [label, re] of BANNED_WORDS) {
    if (re.test(all)) {
      err("banned_word", `The reply uses the banned word "${label}". Use the approved replacement.`);
    }
  }
  const source = String(sourceText).toLowerCase();
  for (const [label, re] of BANNED_CLAIMS) {
    const m = all.match(re);
    if (m && !source.includes(m[0].toLowerCase())) {
      err("banned_claim", `The reply makes an unsupported claim (${label}). Remove it.`);
    }
  }

  const talk = all.match(SOURCE_TALK);
  if (talk) {
    err(
      "source_talk",
      `The copy refers to its source ("${talk[0]}"). State facts directly. Never mention product information, listings or where a fact came from.`
    );
  }

  if (short && long && sameOpening(short, long)) {
    err(
      "same_opening",
      "The first sentence of npr_long_copy repeats the first sentence of npr_short_copy. Open the long copy with a different fact about the product."
    );
  }

  // Disclaimer tags
  if (/<sup/i.test(short)) {
    err("sup_in_short", "npr_short_copy must not contain <sup> disclaimer tags.");
  }
  if (/<sup/i.test(long) && !disclaimers) {
    err("orphan_sup", "npr_long_copy has <sup> tags but disclaimers is empty. Remove the tags.");
  }
  if (/[^\s]<sup>/i.test(long)) {
    err("sup_spacing", "Leave a space before every <sup> tag, for example: fade-free power <sup>1</sup>.");
  }

  // With no document text there is no verified source, so disclaimers must be empty.
  const docNorm = normText(documentText);
  if (!docNorm && disclaimers) {
    err("disclaimer_no_source", 'No disclaimer source was provided. Set disclaimers to "" and remove every <sup> tag.');
  }
  if (docNorm && disclaimers) {
    const { entries, problems } = parseDisclaimers(disclaimers);
    for (const p of problems) err("disclaimer_format", p);
    if (!problems.length) {
      const inOrder = entries.every((e, i) => e.n === i + 1);
      if (!inOrder) err("disclaimer_numbering", "Number the disclaimers 1, 2, 3 in order, with no gaps.");
      const used = [...new Set([...long.matchAll(/<sup>\s*(\d+)\s*<\/sup>/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
      const listed = entries.map((e) => e.n).sort((a, b) => a - b);
      if (used.join(",") !== listed.join(",")) {
        err("sup_mismatch", `The <sup> numbers in npr_long_copy (${used.join(", ") || "none"}) must match the numbered disclaimers (${listed.join(", ")}).`);
      }
      for (const e of entries) {
        if (!isTraceable(e.text, docNorm)) {
          err(
            "disclaimer_untraceable",
            `Disclaimer ${e.n} is not worded like any footnote in the documents. Copy a footnote exactly as written, or remove this disclaimer and its <sup> tag.`
          );
        }
      }
    }
  }

  // Warnings
  const contractions = (long + " " + short).match(CONTRACTION) || [];
  if (long && contractions.length < 2) {
    warn("few_contractions", `Only ${contractions.length} contraction(s) in the copy. Tone should use them throughout.`);
  }
  if (US_SPELLINGS.test(all)) {
    warn("us_spelling", "Possible US spelling. Australian English is required.");
  }
  const brand = product.brand && product.brand.name ? String(product.brand.name).trim() : "";
  if (brand && heading && !heading.toLowerCase().includes(brand.toLowerCase())) {
    warn("heading_brand", `Heading does not include the brand "${brand}".`);
  }
  const finishWord = product.finish ? String(product.finish).trim().split(/\s+/)[0] : "";
  if (finishWord && heading && !heading.toLowerCase().includes(finishWord.toLowerCase())) {
    warn("heading_finish", `Heading does not include the colour/finish "${product.finish}".`);
  }

  return { errors, warnings, stats };
}

// ---------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------
// urls = list of URLs Perplexity says it used. Returns retailer hostnames found.
function findRetailerSources(urls = []) {
  const found = new Set();
  for (const u of urls) {
    let host = "";
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch (e) {
      continue;
    }
    if (RETAILER_HINTS.some((h) => host.includes(h))) found.add(host);
  }
  return [...found];
}

module.exports = {
  LIMITS,
  wordCount,
  validateInput,
  preparePayload,
  extractJson,
  checkCopy,
  findRetailerSources,
};

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
  disclaimersChars: 65535, // confirmed Nexus limit for the disclaimers field (10 Nov 2026)
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
  /\b(?:product (?:information|data|details|listing|description)|(?:mentioned|listed|stated|noted|described) (?:in|on|by)|according to (?:the )?(?:product|listing|data|information|manufacturer|specs?|specifications?|source|brochure|manual)|as (?:listed|stated|mentioned|noted)|the (?:listing|manufacturer'?s? (?:information|data)|source) (?:says|states|lists|shows))\b/i;

// Vague benefit words. NPR wants benefits tied to a real everyday situation,
// so these are flagged (warning only, they are sometimes fine).
const VAGUE_BENEFITS =
  /\b(?:convenient|convenience|flexible|flexibility|versatile|versatility|practical|effortless(?:ly)?|seamless(?:ly)?|hassle-free|peace of mind|(?:a|an) (?:useful|practical|great|smart|solid|sensible) (?:choice|option|addition)|suits a (?:range|variety) of|ideal for anyone|for anyone (?:who|seeking|looking|wanting))\b/gi;

// 1,000 ml or more should be written in litres (2.5L), as the vendors do.
// Words that sound like health claims. Blocked (soft) unless the product data
// uses the word itself. MM to confirm what is acceptable for heating pads,
// massagers and similar products; relax this list if they say so.
const HEALTH_WORDS =
  /\b(?:pain|aches?|aching|sore(?:ness)?|stiff(?:ness)?|tension|muscles?|relieve|relief|soothing|soothe|therapeutic|treat(?:s|ment)?|injury|recovery)\b/gi;

const BIG_ML = /\b\d{1,3}(?:,\d{3})+\s?ml\b|\b\d{4,}\s?ml\b/i;

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

const compact = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "");

// True when the disclaimer wording is found in the document text. PDF text
// extraction can break lines, hyphenate words and drop or add spaces ("AS/NZS 2040"
// or "AS/NZS2040"), so spacing is ignored and a near-exact match is fine:
// 85% of the passage's three-word runs must appear in the document.
function isTraceable(disclaimer, docNorm) {
  const d = normText(disclaimer);
  if (!d) return false;
  if (docNorm.includes(d)) return true;
  const docCompact = docNorm.replace(/ /g, "");
  if (docCompact.includes(d.replace(/ /g, ""))) return true;
  const words = d.split(" ");
  if (words.length < 4) return false;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 3 <= words.length; i++) {
    total++;
    if (docCompact.includes(words.slice(i, i + 3).join(""))) hit++;
  }
  return total > 0 && hit / total >= 0.85;
}

// The first three-word run of the passage that is not in the document, for error messages.
function firstMissingRun(passage, docNorm) {
  const docCompact = docNorm.replace(/ /g, "");
  const words = normText(passage).split(" ");
  for (let i = 0; i + 3 <= words.length; i++) {
    if (!docCompact.includes(words.slice(i, i + 3).join(""))) return words.slice(i, i + 3).join(" ");
  }
  return "";
}

// Short copy must not carry claims that need a disclaimer.
const SHORT_CLAIM = /\d(?:[.,]\d+)?\s?%|\b(?:tested|certified|accredited|independently|clinically|proven|laboratory)\b/i;
// Statistics that need a disclaimer in long copy: percentages and "N times more/less/faster".
const STAT_CLAIM = /\d(?:[.,]\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:x|times)\s+(?:more|less|faster|longer|quieter|stronger)\b/i;
// Certification and test claims in long copy also need a disclaimer. Energy and WELS ratings do not.
const CERT_CLAIM = /\b(?:certified|certification|accredited|independently tested|laboratory[- ]tested|clinically (?:tested|proven)|approved by)\b/i;
const RATING_WORDS = /\b(?:energy|wels|star rating|\d[- ]star)\b/i;
// "100% cotton" is a material, not a performance claim.
const MATERIAL_PERCENT = /\d\s?%\s+(?:\w+\s+){0,2}(?:cotton|polyester|wool|nylon|bamboo|linen|silk|leather|recycled|stainless|cashmere|acrylic|viscose|rayon|microfib\w*|fib(?:re|er)s?|merino|down|feather)\b/i;

// Common words that do not link a claim to its disclaimer.
const CLAIM_STOP = new Set("this that with from your when while have will more than them their they what into over each every also even make makes help helps keep gives give lets easy need needs after before where there these those about only just such most some very much".split(" "));

// Words that assert a test or approval. A drafted disclaimer may use one only if its source passage does.
const CLAIM_WORDS = /\b(?:tested|testing|certified|certification|accredited|independent(?:ly)?|laborator(?:y|ies)|approved|compliant|complies|proven|clinically)\b/gi;

// "(1) Footnote text" lines (NPR format). Returns { entries, problems }.
function parseDisclaimers(text) {
  const entries = [];
  const problems = [];
  const lines = String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/<\/?sup/i.test(line)) {
      problems.push(`Line "${line.slice(0, 40)}" has a <sup> tag. Disclaimers use plain numbers, for example: (1) Footnote text`);
      continue;
    }
    const m = line.match(/^\(\s*(\d+)\s*\)\s+(\S.*)$/);
    if (!m) {
      problems.push(`Line "${line.slice(0, 40)}" is not in the form: (1) Footnote text`);
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
// either 5+ opening words in a row match, or half or more of the words are shared.
function sameOpening(short, long) {
  const a = firstSentenceWords(short);
  const b = firstSentenceWords(long);
  if (a.length < 6 || b.length < 6) return false;
  let lead = 0;
  while (lead < a.length && lead < b.length && a[lead] === b[lead]) lead++;
  if (lead >= 5) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / new Set([...sa, ...sb]).size >= 0.5;
}

// Problem-first openings: the first sentence should start with the buyer's
// everyday problem, not with the product. It counts as product-first when
//   (a) the brand name is in the first four words ("LG CordZero vacuum ..."), or
//   (b) it starts with This / The / Our / Introducing / Meet and a word from the
//       heading follows within four words ("This stick vacuum ...").
// A problem sentence that merely uses a category word ("Lower back aches ...")
// is fine.
const OPENING_STOP = new Set(["with", "this", "that", "from", "your", "have", "also", "into", "more", "the", "and", "for"]);
function opensWithProduct(text, heading, brand = "") {
  const words = firstSentenceWords(text);
  if (!words.length) return false;
  const brandWord = String(brand || String(heading).split(/\s+/)[0] || "").toLowerCase().match(/[a-z0-9]+/);
  if (brandWord && words.slice(0, 4).includes(brandWord[0])) return true;
  if (/^(this|the|our|introducing|meet|these)$/.test(words[0])) {
    const headWords = new Set(
      (String(heading).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !OPENING_STOP.has(w))
    );
    return words.slice(1, 5).some((w) => headWords.has(w));
  }
  return false;
}

// ---------------------------------------------------------------------
// Terms that come only from the attached documents
// ---------------------------------------------------------------------
// Documents are for disclaimer footnotes only. If the copy uses a capitalised or
// CamelCase term (an app name, a feature name) that is in the documents but not
// in the product data, it was taken from a document. Manuals often cover several
// models, so this matters.
const DOC_TERM_SKIP = new Set([
  "australia", "australian", "zealand", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
]);

function docOnlyTerms(text, srcNorm, docNorm) {
  const srcWords = new Set(srcNorm.split(" "));
  const docWords = new Set(docNorm.split(" "));
  const found = new Set();
  const re = /[A-Za-z][A-Za-z0-9]*/g;
  let m;
  while ((m = re.exec(text))) {
    const w = m[0];
    if (w.length < 4) continue;
    const camel = /[a-z][A-Z]/.test(w);
    const capital = /^[A-Z]/.test(w);
    if (!camel && !capital) continue;
    if (!camel) {
      // a plain capital at the start of a sentence is not a name
      const before = text.slice(0, m.index).replace(/[ \t"'(\u2018\u201C]+$/, "");
      if (!before || /[.!?:\n]$/.test(before)) continue;
    }
    const t = w.toLowerCase();
    const base = t.replace(/s$/, "");
    if (DOC_TERM_SKIP.has(t)) continue;
    if (srcWords.has(t) || srcWords.has(base)) continue;
    if (docWords.has(t) || docWords.has(base)) found.add(w);
  }
  return [...found];
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
  const brand0 = product.brand && product.brand.name ? String(product.brand.name).trim() : "";

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
    err(
      "long_words_low",
      `npr_long_copy is ${stats.longWords} words. It must be 200 to 300 words. Write 230 to 280 words, about 60 to 70 words per paragraph, by adding specific everyday detail from the product data. Do not pad.`
    );
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
  // A disclaimer may carry a word from its own source passage (the manufacturer's wording).
  const quotesText = (Array.isArray(copy.disclaimer_evidence) ? copy.disclaimer_evidence : [])
    .map((x) => (x && typeof x.quote === "string" ? x.quote : ""))
    .join("\n");
  const copyOnly = [heading, short, long].join("\n");
  const scan = (re) => re.test(copyOnly) || (re.test(disclaimers) && !re.test(quotesText));
  for (const [label, re] of BANNED_WORDS) {
    if (scan(re)) {
      err("banned_word", `The reply uses the banned word "${label}". Use the approved replacement.`);
    }
  }
  const source = String(sourceText).toLowerCase();
  for (const [label, re] of BANNED_CLAIMS) {
    const m = copyOnly.match(re) || (disclaimers.match(re) && !re.test(quotesText) ? disclaimers.match(re) : null);
    if (m && !source.includes(m[0].toLowerCase())) {
      err("banned_claim", `The reply makes an unsupported claim (${label}). Remove it.`);
    }
  }

  const talk = [heading, short, long].join("\n").match(SOURCE_TALK); // disclaimers may quote their source
  if (talk) {
    err(
      "source_talk",
      `The copy refers to its source ("${talk[0]}"). State facts directly. Never mention product information, listings or where a fact came from.`
    );
  }

  if (short && heading && opensWithProduct(short, heading, brand0)) {
    err(
      "opening_product_first",
      "npr_short_copy opens with the product name. Open with the everyday problem this product solves, then show how this product answers it."
    );
  }
  if (long && heading && opensWithProduct(long, heading, brand0)) {
    err(
      "opening_product_first",
      "npr_long_copy opens with the product name. Open with the everyday problem this product solves, then show how this product answers it."
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
  // The tag sits at the end of the sentence, before the full stop.
  {
    const bad = [...long.matchAll(/(?:<sup>\s*\d+\s*<\/sup>[ \t]*)+/gi)].filter((m) => !/^[.!?]/.test(long.slice(m.index + m[0].length)));
    if (bad.length) {
      err("sup_position", "Put each <sup> tag at the end of its sentence, before the full stop, for example: fade-free power <sup>1</sup>.");
    }
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
      // Drafted wording is allowed, but each disclaimer must carry the exact source passage
      // it rests on, and nothing in the wording may go beyond that passage.
      const evidence = Array.isArray(copy.disclaimer_evidence) ? copy.disclaimer_evidence : [];
      for (const e of entries) {
        const item = evidence.find((x) => x && Number(x.n) === e.n && typeof x.quote === "string" && x.quote.trim());
        if (!item) {
          err(
            "evidence_missing",
            `Disclaimer ${e.n} has no source passage. Add {"n": ${e.n}, "quote": "..."} to disclaimer_evidence with the exact passage from DISCLAIMER SOURCES, or remove this disclaimer and its <sup> tag.`
          );
          continue;
        }
        if (!isTraceable(item.quote, docNorm)) {
          err(
            "evidence_untraceable",
            `The source passage for disclaimer ${e.n} is not in the documents (the words "${firstMissingRun(item.quote, docNorm)}" were not found). Copy the passage exactly as written, or remove this disclaimer and its <sup> tag.`
          );
          continue;
        }
        const q = ` ${normText(item.quote)} `;
        const cores = (t) => (String(t).match(/\d+(?:[.,]\d+)*/g) || []).map((f) => f.replace(/[.,]/g, ""));
        const inQuote = new Set(cores(item.quote));
        const stray = [...new Set(cores(e.text))].filter((f) => !inQuote.has(f));
        if (stray.length) {
          err(
            "disclaimer_figure",
            `Disclaimer ${e.n} uses ${stray.join(", ")}, which is not in its source passage. Use only figures the passage states.`
          );
        }
        // The sentence a disclaimer is attached to must be about what the disclaimer says.
        if (typeof item.claim === "string" && item.claim.trim()) {
          const key = (t) => new Set((String(t).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !CLAIM_STOP.has(w)).map((w) => w.slice(0, 5)));
          const have = key(`${e.text} ${item.quote}`);
          const related = [...key(item.claim)].some((w) => have.has(w));
          if (!related) {
            err(
              "claim_unrelated",
              `Disclaimer ${e.n} is attached to a sentence that is not about what it says. Attach it to the sentence that makes the claim it qualifies. If the copy does not make that claim, remove the disclaimer.`
            );
          }
        }
        const claimWords = [...new Set((e.text.toLowerCase().match(CLAIM_WORDS) || []).map((w) => normText(w)))];
        const strayWords = claimWords.filter((w) => !q.includes(` ${w} `));
        if (strayWords.length) {
          err(
            "disclaimer_claim_word",
            `Disclaimer ${e.n} says "${strayWords.join('", "')}", which its source passage does not say. Remove it.`
          );
        }
      }
    }
  }

  // Short copy stays general. Claims that need a disclaimer belong in the long copy, or nowhere.
  if (SHORT_CLAIM.test(short)) {
    err(
      "short_claim",
      "npr_short_copy contains a claim that needs a disclaimer (a percentage, test result or certification). Say it as a general feature or leave it out."
    );
  }
  // A statistic in the long copy with no tag: add a disclaimer if a source supports one, otherwise narrow or remove it.
  {
    const bare = long
      .split(/(?<=[.!?])\s+/)
      .filter(
        (sent) =>
          !/<sup>/i.test(sent) &&
          ((STAT_CLAIM.test(sent) && !MATERIAL_PERCENT.test(sent)) || (CERT_CLAIM.test(sent) && !RATING_WORDS.test(sent)))
      );
    if (bare.length) {
      err(
        "stat_no_disclaimer",
        `This sentence states a statistic, test or certification with no disclaimer: "${bare[0].slice(0, 90)}". Add a disclaimer only if DISCLAIMER SOURCES support it. Otherwise narrow the claim to what the product data supports, or remove it.`
      );
    }
  }

  // Warnings
  const contractions = (long + " " + short).match(CONTRACTION) || [];
  if (long && contractions.length < 2) {
    warn("few_contractions", `Only ${contractions.length} contraction(s) in the copy. Tone should use them throughout.`);
  }
  const vague = [...new Set((all.match(VAGUE_BENEFITS) || []).map((w) => w.toLowerCase()))];
  if (vague.length) {
    warn("vague_benefit", `Vague benefit words: ${vague.join(", ")}. Say what it means in everyday use instead.`);
  }
  // Health-benefit wording is blocked unless the product data itself uses the word.
  const healthHits = [...new Set((all.match(HEALTH_WORDS) || []).map((w) => w.toLowerCase()))].filter(
    (w) => !source.includes(w) && !source.includes(w.replace(/s$/, ""))
  );
  if (healthHits.length) {
    err(
      "health_claim",
      `The copy uses health-benefit wording (${healthHits.join(", ")}) that the product data does not use. Describe the everyday situation (long hours at a desk, cold evenings, holding a heat pack in place) and comfort, never pain, tension, muscles or relief.`
    );
  }
  if (docNorm) {
    const terms = docOnlyTerms([heading, short, long].join("\n"), normText(sourceText), docNorm);
    if (terms.length) {
      err(
        "doc_only_term",
        `The copy uses ${terms.join(", ")}, which appears only in an attached document and not in the product data. Documents are for disclaimer footnotes only. Remove it and use only what the product data says.`
      );
    }
  }
  if (BIG_ML.test(all)) {
    warn("unit_ml", "A capacity of 1,000 ml or more should be written in litres, for example 2.5L.");
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
// review_notes from the model: a short list of plain sentences. Anything else is dropped.
function cleanReviewNotes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n) => typeof n === "string")
    .map((n) => n.replace(/\s+/g, " ").replace(/—/g, ",").replace(/\*\*|^#+\s*/g, "").trim().slice(0, 250))
    .filter(Boolean)
    .slice(0, 5);
}

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
  cleanReviewNotes,
  findRetailerSources,
};

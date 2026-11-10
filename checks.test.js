// checks.test.js
//
// Free, instant tests for checks.js. No API calls.
// Run with:  npm test
//
// When a new failure case turns up (for example from Shikha's screenshots),
// add the bad text here as a new test. It then stays fixed forever.

const test = require("node:test");
const assert = require("node:assert");
const {
  validateInput,
  preparePayload,
  extractJson,
  checkCopy,
  cleanReviewNotes,
  findRetailerSources,
} = require("./checks");

// ---- Two real outputs from prompt v0.2 (22 Oct 2026). Both should pass. ----
const LG = {
  product: { modelNo: "A9L-TOWER", brand: { name: "LG" }, finish: "Grey" },
  copy: {
    npr_heading: "LG CordZero Stick Vacuum with All-in-One Tower – Grey",
    npr_short_copy:
      "Dust bins that fill up mid-clean slow everyone down. This LG CordZero stick vacuum pairs 220W suction and a 60-minute runtime with a tower that charges it, empties dust hygienically and stores accessories, so cleaning hard floors and carpets takes less effort.",
    npr_long_copy:
      "Juggling a vacuum, a charger and a pile of attachments makes a quick clean feel like a chore. With 220W suction power and a 60-minute runtime, this vacuum helps you move from quick daily tidy-ups to more thorough cleaning across hard floors and carpets. Its ergonomic handle also makes it easier to guide around your home.\n\nThe All-in-One Tower brings charging, hygienic auto dust emptying and accessory storage together in one place, so this vacuum is ready for the next clean without leaving dust and attachments scattered around. Kompressor technology compresses collected dirt to help make better use of the 2,500ml dust capacity, while the dual nozzle system gives you more flexibility across different floor surfaces.\n\nFor more than dry vacuuming, this model includes a Power Drive mop to help tackle wet cleaning on suitable hard floors. One Touch Control keeps operation straightforward, and the Smart Inverter motor is designed to support reliable performance. When it’s time for maintenance, the washable dust bin and filters can be cleaned and reused, helping keep ongoing care simple.\n\nFinished in Grey, this LG CordZero suits homes that need a versatile cordless cleaner for carpets, hard floors and wet cleaning. The All-in-One Tower also provides a neat home for this vacuum and its accessories, while the included two-year warranty offers added reassurance. It’s a practical choice for anyone who wants powerful cleaning and less effort between uses.",
    disclaimers: "",
  },
};

const SUNBEAM = {
  product: { modelNo: "HPB5400", brand: { name: "Sunbeam" }, finish: "Grey" },
  copy: {
    npr_heading: "Sunbeam Lower Back Heating Pad – Grey",
    npr_short_copy:
      "Holding a heat pack against your back gets old fast. This Sunbeam Lower Back Heating Pad stays put with an adjustable strap, heats up in 90 seconds and offers five heat settings, with auto-off and machine-washable fabric for easy care.",
    npr_long_copy:
      "Holding a heat pack in place while you work or relax rarely lasts long. Its adjustable strap fits waists up to 54 inches, helping keep this pad comfortably in place so heat reaches your lower back. The flexible design improves body contact for a more comfortable fit.\n\nChoose from five heat settings using this pad's digital controller, so you'll have more control over the warmth that suits you. It heats up in 90 seconds, helping you settle into comfort without a long wait. The multipurpose design also makes this pad useful beyond the lower back when focused warmth is wanted.\n\nIntellisense Technology helps prevent overheating and maintain a consistent temperature during use. The three-hour automatic switch-off cuts power after continuous use, adding reassurance when you're relaxing. A detachable controller makes this pad simpler to prepare for washing, while the soft polyester fabric is machine washable for easier care.\n\nFinished in Grey, this 110-watt heating pad measures 370mm wide by 370mm high and weighs 0.95kg. Its 220cm cord gives you flexibility when positioning it near a power point. This Sunbeam heating pad is suitable for anyone seeking adjustable, focused warmth at home, and it includes a two-year warranty. If you spend long hours at a desk, it gives your lower back steady warmth without a hot water bottle to refill.",
    disclaimers: "",
  },
};

const names = (list) => list.map((x) => x.check);
const run = (fx, patch = {}, opts = {}) =>
  checkCopy({ ...fx.copy, ...patch }, { product: fx.product, sourceText: "", ...opts });

// ---- Good output passes -------------------------------------------------
test("real v0.2 LG output passes with no errors", () => {
  assert.deepStrictEqual(names(run(LG).errors), []);
});

test("real v0.2 Sunbeam output passes with no errors", () => {
  assert.deepStrictEqual(names(run(SUNBEAM).errors), []);
});

// ---- Rules ---------------------------------------------------------------
test("model code in the heading is blocked (the v0.1 LG failure)", () => {
  const r = run(LG, { npr_heading: "LG CordZero A9L-TOWER Stick Vacuum with All-in-One Tower – Grey" });
  assert.ok(names(r.errors).includes("model_code"));
});

test("model code in the body is blocked, case-insensitive", () => {
  const r = run(SUNBEAM, { npr_short_copy: "This Sunbeam hpb5400 heating pad is warm." });
  assert.ok(names(r.errors).includes("model_code"));
});

test("em dash is blocked, en dash in the heading is fine", () => {
  const r = run(SUNBEAM, { npr_short_copy: "Warm — and cosy." });
  assert.ok(names(r.errors).includes("em_dash"));
  assert.ok(!names(run(SUNBEAM).errors).includes("em_dash"));
});

test("banned words are blocked, including inside hyphenated words", () => {
  const r = run(SUNBEAM, { npr_short_copy: "German-engineered warmth you can trust." });
  assert.ok(names(r.errors).includes("banned_word"));
});

test("'rangehood' does not trip the 'hood' rule", () => {
  const r = run(SUNBEAM, { npr_short_copy: "This rangehood clears the air quickly." });
  assert.ok(!names(r.errors).includes("banned_word"));
});

test("banned claim is blocked unless the product data says it", () => {
  const patch = { npr_short_copy: "This is the world's first heating pad you'll love." };
  assert.ok(names(run(SUNBEAM, patch).errors).includes("banned_claim"));
  assert.ok(!names(run(SUNBEAM, patch, { sourceText: "the world's first heating pad" }).errors).includes("banned_claim"));
});

test("<sup> tag in short copy is blocked", () => {
  const r = run(SUNBEAM, { npr_short_copy: "Heats in 90 seconds <sup>1</sup>.", disclaimers: "(1) Tested." });
  assert.ok(names(r.errors).includes("sup_in_short"));
});

test("<sup> tag in long copy with empty disclaimers is blocked", () => {
  const long = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait <sup>1</sup>.");
  assert.ok(long.includes("<sup>1</sup>"), "test setup: tag should be in the text");
  const r = run(SUNBEAM, { npr_long_copy: long });
  assert.ok(names(r.errors).includes("orphan_sup"));
});

test("three paragraphs is blocked", () => {
  const three = SUNBEAM.copy.npr_long_copy.split("\n\n").slice(0, 3).join("\n\n");
  assert.ok(names(run(SUNBEAM, { npr_long_copy: three }).errors).includes("paragraphs"));
});

test("long copy over 2000 characters is blocked", () => {
  const r = run(SUNBEAM, { npr_long_copy: SUNBEAM.copy.npr_long_copy + "\n\n" + "word ".repeat(450) });
  const n = names(r.errors);
  assert.ok(n.includes("long_chars"));
  assert.ok(n.includes("long_words"));
});

test("short copy over 50 words is blocked", () => {
  const r = run(SUNBEAM, { npr_short_copy: "warm ".repeat(60).trim() });
  assert.ok(names(r.errors).includes("short_words"));
});

test("citation markers and markdown are blocked", () => {
  assert.ok(names(run(SUNBEAM, { npr_short_copy: "Heats fast [1] and stays warm." }).errors).includes("citation_marker"));
  assert.ok(names(run(SUNBEAM, { npr_short_copy: "**Heats** fast." }).errors).includes("markdown"));
});

test("missing or non-string fields are a schema error", () => {
  assert.ok(names(checkCopy({ npr_heading: "x" }, {}).errors).includes("schema"));
  assert.ok(names(checkCopy(null, {}).errors).includes("schema"));
});

test("no contractions gives a warning, not an error", () => {
  const r = run(SUNBEAM, {
    npr_short_copy: "This heating pad is warm.",
    npr_long_copy: SUNBEAM.copy.npr_long_copy.replace(/[’']/g, "").replace(/you'll|youll/g, "you will"),
  });
  assert.ok(names(r.warnings).includes("few_contractions"));
  assert.ok(!names(r.errors).includes("few_contractions"));
});

test("long copy repeating the short copy's opening sentence is blocked (v0.3 LG run)", () => {
  const patch = {
    npr_short_copy:
      "This LG CordZero stick vacuum combines up to 220W suction with a 2.5L dust capacity for longer cleaning sessions. The tower charges and empties it.",
    npr_long_copy: LG.copy.npr_long_copy.replace(
      /^[^.]*\./,
      "This LG CordZero stick vacuum combines up to 220W suction with a large 2.5L dust capacity, so you'll have plenty of room for everyday dirt and debris."
    ),
  };
  assert.ok(names(run(LG, patch).errors).includes("same_opening"));
});

test("different opening sentences pass (both real v0.2 outputs)", () => {
  assert.ok(!names(run(LG).errors).includes("same_opening"));
  assert.ok(!names(run(SUNBEAM).errors).includes("same_opening"));
});

test("copy that talks about its source is blocked (v0.3 agent-mode LG run)", () => {
  const bad1 = "A Power Drive mop is also mentioned in the product information, adding another cleaning option.";
  const bad2 = "The product information lists a 60-minute runtime, giving you time to clean before recharging.";
  assert.ok(names(run(LG, { npr_long_copy: LG.copy.npr_long_copy + "\n\n" + bad1 }).errors).includes("source_talk"));
  assert.ok(names(run(LG, { npr_long_copy: LG.copy.npr_long_copy + "\n\n" + bad2 }).errors).includes("source_talk"));
  assert.ok(!names(run(LG).errors).includes("source_talk"));
  assert.ok(!names(run(SUNBEAM).errors).includes("source_talk"));
});

// ---- Disclaimers (Phase 4) -------------------------------------------------
const DOC = "Independently tested to eliminate greater than 99.9% of staphylococcus aureus and E. coli using the Allergy Care cycle.";
const EV = [{ n: 1, quote: DOC }];
const withDisc = (longText, disclaimers, documentText = DOC, evidence = EV) =>
  run(SUNBEAM, { npr_long_copy: longText, disclaimers, disclaimer_evidence: evidence }, { documentText });
const LONG_SUP = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait <sup>1</sup>.");

test("a disclaimer copied from the document passes", () => {
  assert.deepStrictEqual(names(withDisc(LONG_SUP, `(1) ${DOC}`).errors), []);
});

test("a disclaimer with a source passage that is not in the document is blocked", () => {
  const fake = "Kills every germ in the house within five minutes of use.";
  const r = withDisc(LONG_SUP, `(1) ${fake}`, DOC, [{ n: 1, quote: fake }]);
  assert.ok(names(r.errors).includes("evidence_untraceable"));
});

test("PDF line breaks and hyphenation do not break the match", () => {
  const messy = "Independently tested to eliminate greater\nthan 99.9% of staphylococcus aureus and E. coli\nusing the Allergy Care cycle.";
  assert.deepStrictEqual(names(withDisc(LONG_SUP, `(1) ${DOC}`, messy).errors), []);
});

// ---- Drafted disclaimers (Option B) ---------------------------------------
const SAFETY = "Accessible surface temperatures can be high when the appliance is operating. Never touch these surfaces, always use the handles.";
test("a disclaimer drafted in new words passes when its passage is in the source and adds nothing", () => {
  const r = withDisc(LONG_SUP, "(1) Surfaces can be hot during use. Always use the handles.", SAFETY, [{ n: 1, quote: SAFETY }]);
  assert.deepStrictEqual(names(r.errors), []);
});

test("a drafted disclaimer with no source passage is blocked", () => {
  const r = withDisc(LONG_SUP, "(1) Surfaces can be hot during use.", SAFETY, []);
  assert.ok(names(r.errors).includes("evidence_missing"));
});

test("a drafted disclaimer cannot add a figure that the passage does not state", () => {
  const r = withDisc(LONG_SUP, "(1) Surfaces can reach 80 degrees during use.", SAFETY, [{ n: 1, quote: SAFETY }]);
  assert.ok(names(r.errors).includes("disclaimer_figure"));
});

test("a figure that the passage states is allowed", () => {
  const src = "Tested at 25C ambient. Results vary.";
  const r = withDisc(LONG_SUP, "(1) Tested at 25C ambient.", src, [{ n: 1, quote: src }]);
  assert.ok(!names(r.errors).includes("disclaimer_figure"));
});

test("a drafted disclaimer cannot claim a test or certification that the passage does not state", () => {
  const r = withDisc(LONG_SUP, "(1) Independently tested. Surfaces can be hot.", SAFETY, [{ n: 1, quote: SAFETY }]);
  assert.ok(names(r.errors).includes("disclaimer_claim_word"));
});

// ---- Short copy and bare statistics ----------------------------------------
test("short copy with a percentage or test claim is flagged (soft)", () => {
  const r = run(SUNBEAM, { npr_short_copy: "Removes 99.9% of dust from hard floors every time you clean." });
  assert.ok(names(r.errors).includes("short_claim"));
  const r2 = run(SUNBEAM, { npr_short_copy: "Independently tested for everyday use on hard floors and rugs." });
  assert.ok(names(r2.errors).includes("short_claim"));
});

test("a statistic in long copy with no tag is flagged, a material percentage is not", () => {
  const stat = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait, saving 15% energy.");
  assert.ok(names(run(SUNBEAM, { npr_long_copy: stat }).errors).includes("stat_no_disclaimer"));
  const material = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait, and the cover is 100% polyester.");
  assert.ok(!names(run(SUNBEAM, { npr_long_copy: material }).errors).includes("stat_no_disclaimer"));
});

test("a tagged statistic is not flagged", () => {
  const tagged = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait, saving 15% energy <sup>1</sup>.");
  assert.ok(!names(withDisc(tagged, `(1) ${DOC}`).errors).includes("stat_no_disclaimer"));
});

test("disclaimers with no document text are blocked", () => {
  const r = withDisc(LONG_SUP, `(1) ${DOC}`, "");
  assert.ok(names(r.errors).includes("disclaimer_no_source"));
});

test("sup numbers must match the numbered disclaimers", () => {
  const r = withDisc(LONG_SUP, `(1) ${DOC}\n(2) ${DOC}`);
  assert.ok(names(r.errors).includes("sup_mismatch"));
});

test("disclaimers must be numbered in order and in the (1) form", () => {
  assert.ok(names(withDisc(LONG_SUP, `(2) ${DOC}`).errors).includes("disclaimer_numbering"));
  assert.ok(names(withDisc(LONG_SUP, `1. ${DOC}`).errors).includes("disclaimer_format"));
});

test("<sup> tags inside the disclaimers block are blocked", () => {
  assert.ok(names(withDisc(LONG_SUP, `<sup>1</sup> ${DOC}`).errors).includes("disclaimer_format"));
  assert.ok(names(withDisc(LONG_SUP, `(1) <sup>1</sup> ${DOC}`).errors).includes("disclaimer_format"));
});

test("a <sup> tag goes at the end of the sentence, before the full stop", () => {
  const mid = SUNBEAM.copy.npr_long_copy.replace("in 90 seconds,", "in 90 seconds <sup>1</sup>,");
  assert.ok(names(withDisc(mid, `(1) ${DOC}`).errors).includes("sup_position"));
  const after = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait. <sup>1</sup>");
  assert.ok(names(withDisc(after, `(1) ${DOC}`).errors).includes("sup_position"));
  assert.ok(!names(withDisc(LONG_SUP, `(1) ${DOC}`).errors).includes("sup_position"));
});

test("a <sup> tag needs a space before it", () => {
  const tight = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait<sup>1</sup>.");
  assert.ok(names(withDisc(tight, `(1) ${DOC}`).errors).includes("sup_spacing"));
});

// ---- MM feedback, 29 Oct 2026 --------------------------------------------
test("opening with the product name is blocked, short and long (v0.3 live runs)", () => {
  const short = run(LG, { npr_short_copy: "This LG CordZero stick vacuum combines up to 220W suction with a 2.5L tower bag for longer cleaning sessions." });
  assert.ok(names(short.errors).includes("opening_product_first"));
  const long = run(LG, { npr_long_copy: LG.copy.npr_long_copy.replace(/^[^.]*\./, "This LG CordZero stick vacuum is built for everyday cleaning.") });
  assert.ok(names(long.errors).includes("opening_product_first"));
});

test("a problem sentence that uses a category word is not flagged (Sunbeam retry loop)", () => {
  const r = run(SUNBEAM, {
    npr_short_copy: "Lower back aches after a long day at the desk are hard to ignore. This Sunbeam pad offers focused warmth with five heat settings and an adjustable strap.",
    npr_long_copy: SUNBEAM.copy.npr_long_copy.replace(/^[^.]*\./, "Lower back stiffness after hours at a laptop can make it hard to relax."),
  });
  assert.ok(!names(r.errors).includes("opening_product_first"));
});

test("brand-first and 'This <product>' openings are flagged", () => {
  const brand = run(SUNBEAM, { npr_short_copy: "Sunbeam heating pads give focused warmth with five heat settings and a strap." });
  assert.ok(names(brand.errors).includes("opening_product_first"));
  const thisProduct = run(SUNBEAM, { npr_short_copy: "This heating pad gives focused warmth with five heat settings and a strap." });
  assert.ok(names(thisProduct.errors).includes("opening_product_first"));
});

test("near-identical problem openings in short and long copy are blocked (v0.5 Sunbeam, live)", () => {
  const r = run(SUNBEAM, {
    npr_short_copy: "Lower back tension can make working or relaxing uncomfortable. This heating pad has an adjustable strap and five heat settings.",
    npr_long_copy: SUNBEAM.copy.npr_long_copy.replace(/^[^.]*\./, "Lower back tension can make sitting at a laptop or relaxing at home uncomfortable."),
  });
  assert.ok(names(r.errors).includes("same_opening"));
});

test("generic closers give a warning, not an error", () => {
  const r = run(SUNBEAM, { npr_short_copy: "Warmth for your lower back. This pad is a useful choice for anyone seeking a strap-on heat pad." });
  assert.ok(names(r.warnings).includes("vague_benefit"));
  assert.ok(!names(r.errors).includes("vague_benefit"));
});

test("health-benefit wording is blocked unless the product data uses it (v0.5 Sunbeam, live)", () => {
  const long = SUNBEAM.copy.npr_long_copy.replace(/^[^.]*\./, "Lower back pain can make sitting at a laptop uncomfortable.");
  const r = run(SUNBEAM, { npr_long_copy: long + " It offers soothing heat for muscle tension." });
  assert.ok(names(r.errors).includes("health_claim"));
  const allowed = run(SUNBEAM, { npr_long_copy: long + " It offers soothing heat for muscle tension." }, { sourceText: "relieves lower back pain, soothing heat, muscle tension" });
  assert.ok(!names(allowed.errors).includes("health_claim"));
});

test("problem-first openings pass", () => {
  assert.ok(!names(run(LG).errors).includes("opening_product_first"));
  assert.ok(!names(run(SUNBEAM).errors).includes("opening_product_first"));
});

test("long copy under 200 words is now a blocking error", () => {
  const short3 = LG.copy.npr_long_copy.split("\n\n").map((p) => p.split(". ").slice(0, 2).join(". ") + ".").join("\n\n");
  assert.ok(names(run(LG, { npr_long_copy: short3 }).errors).includes("long_words_low"));
});

test("vague benefit words and big ml figures give warnings, not errors", () => {
  const r = run(SUNBEAM, { npr_short_copy: "A convenient pad with more flexibility and a 2,500ml tank." });
  assert.ok(names(r.warnings).includes("vague_benefit"));
  assert.ok(names(r.warnings).includes("unit_ml"));
  assert.ok(!names(r.errors).includes("vague_benefit"));
  assert.ok(!names(run(SUNBEAM, { npr_short_copy: "A 2.5L tank keeps going." }).warnings).includes("unit_ml"));
});

// ---- Input handling --------------------------------------------------------
test("validateInput lists what is missing", () => {
  assert.deepStrictEqual(validateInput({ ean: "1", heading: "x", modelNo: "M", brand: { name: "B" }, defaultdisplaycategory: { name: "C" }, categoryAttributes: {} }), []);
  assert.deepStrictEqual(validateInput({ ean: "1" }), ["heading", "modelNo", "brand.name", "defaultdisplaycategory.name", "categoryAttributes"]);
  assert.strictEqual(validateInput(null).length, 1);
  assert.strictEqual(validateInput([]).length, 1);
});

test("preparePayload strips attachments, trims, drops nulls", () => {
  const out = preparePayload({
    ean: "9415112611890 ",
    productbrochures: [{ id: "x", uri: "http://127.0.0.1/x" }],
    productusermanuals: [],
    weight: null,
    finish: "White ",
    categoryAttributes: { "Cord Length (cm)\t": "220", "Display Type": null, "Auto Off": true, "Remote Control": false },
  });
  assert.strictEqual(out.ean, "9415112611890");
  assert.strictEqual(out.finish, "White");
  assert.ok(!("productbrochures" in out) && !("productusermanuals" in out) && !("weight" in out));
  assert.deepStrictEqual(out.categoryAttributes, { "Cord Length (cm)": "220", "Auto Off": true, "Remote Control": false });
});

test("extractJson handles fences and surrounding text", () => {
  assert.deepStrictEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('Here you go: {"a":1} Hope that helps'), { a: 1 });
  assert.strictEqual(extractJson("not json"), null);
  assert.strictEqual(extractJson(undefined), null);
});

test("findRetailerSources flags retailer hostnames only", () => {
  const urls = ["https://www.haier.com.au/x", "https://www.binglee.com.au/p/1", "https://winnings.com.au/y", "not a url"];
  assert.deepStrictEqual(findRetailerSources(urls).sort(), ["winnings.com.au", "www.binglee.com.au"]);
});


// ---- Terms that come only from the documents ----------------------------
test("a term found only in the documents (an app name) is flagged", () => {
  const long = LG.copy.npr_long_copy + " Control it from the ConnectLife app.";
  const r = run(LG, { npr_long_copy: long }, { sourceText: JSON.stringify(LG.product), documentText: "Use the ConnectLife app to control the oven. Wi-Fi setup." });
  assert.ok(names(r.errors).includes("doc_only_term"));
  assert.ok(r.errors.find((e) => e.check === "doc_only_term").message.includes("ConnectLife"));
});

test("the same term is fine when the product data uses it", () => {
  const long = LG.copy.npr_long_copy + " Control it from the ConnectLife app.";
  const r = run(LG, { npr_long_copy: long }, { sourceText: JSON.stringify({ ...LG.product, webCopy: "ConnectLife app" }), documentText: "Use the ConnectLife app." });
  assert.ok(!names(r.errors).includes("doc_only_term"));
});

test("no documents, no document-term check", () => {
  const long = LG.copy.npr_long_copy + " Control it from the ConnectLife app.";
  assert.ok(!names(run(LG, { npr_long_copy: long }, { sourceText: JSON.stringify(LG.product) }).errors).includes("doc_only_term"));
});

test("ordinary sentence-start capitals and months are not flagged", () => {
  const r = run(LG, {}, { sourceText: JSON.stringify(LG.product), documentText: "Dust bins. Finished in November. Washable filters. Australian standards." });
  assert.ok(!names(r.errors).includes("doc_only_term"));
});

test("review_notes are cleaned: strings only, no em dashes, five at most", () => {
  const out = cleanReviewNotes(["npr_long_copy: removed a claim \u2014 no source.", 7, "", "b", "c", "d", "e", "f"]);
  assert.strictEqual(out.length, 5);
  assert.ok(!out[0].includes("\u2014"));
  assert.deepStrictEqual(cleanReviewNotes("nope"), []);
});

test("a certification claim in long copy with no tag is flagged, an energy rating is not", () => {
  const cert = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait, and Woolmark Green certification supports gentle care.");
  assert.ok(names(run(SUNBEAM, { npr_long_copy: cert }).errors).includes("stat_no_disclaimer"));
  const rating = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait, and the energy certification is 5 stars.");
  assert.ok(!names(run(SUNBEAM, { npr_long_copy: rating }).errors).includes("stat_no_disclaimer"));
});

test("the disclaimers field allows up to 65,535 characters", () => {
  const { LIMITS } = require("./checks");
  assert.strictEqual(LIMITS.disclaimersChars, 65535);
});

test('"according to the load weight" is normal copy, "according to the product information" is not', () => {
  const ok = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait, and it adjusts according to the load weight.");
  assert.ok(!names(run(SUNBEAM, { npr_long_copy: ok }).errors).includes("source_talk"));
  const bad = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait, according to the product information.");
  assert.ok(names(run(SUNBEAM, { npr_long_copy: bad }).errors).includes("source_talk"));
});

test("a disclaimer may quote its source with words like 'described in' or 'in accordance with'", () => {
  const src = "The program is described in the label and is in accordance with AS/NZS 2040 and AS/NZS 6400.";
  const r = withDisc(LONG_SUP, "(1) The program is in accordance with AS/NZS2040 and AS/NZS6400.", src, [{ n: 1, quote: src }]);
  assert.deepStrictEqual(names(r.errors), []);
});

test("figures inside names like MS2 are matched as whole tokens", () => {
  const src = "Tested for MS2 Bacteriophage in an external test performed in 2021 (Test Report No. 202120117).";
  const r = withDisc(LONG_SUP, "(1) Tested for MS2 Bacteriophage in an external test in 2021 (Test Report No. 202120117).", src, [{ n: 1, quote: src }]);
  assert.ok(!names(r.errors).includes("disclaimer_figure"), JSON.stringify(r.errors));
});

test("a passage with different spacing in the PDF still matches, and the error names the missing words", () => {
  const src = "Recommended in accordance with AS/NZS 2040 and AS/NZS 6400 for a normally soiled load.";
  const ok = withDisc(LONG_SUP, "(1) Recommended in accordance with AS/NZS2040.", src, [{ n: 1, quote: "Recommended in accordance with AS/NZS2040 and AS/NZS6400 for a normally soiled load." }]);
  assert.ok(!names(ok.errors).includes("evidence_untraceable"));
  const bad = withDisc(LONG_SUP, "(1) Something else entirely written here for a test.", src, [{ n: 1, quote: "Something else entirely written here for a test." }]);
  const e = bad.errors.find((x) => x.check === "evidence_untraceable");
  assert.ok(e && /were not found/.test(e.message));
});

// ---- From the 10 Nov DEBUG_RAW run ------------------------------------------
test("figure ranges and lists are matched one by one: 1-4, speed 4 & 5", () => {
  const src = "Setting 1-4 are for prolonged use; Setting 5 is for rapid heat up only. While operating on speed 4 & 5 the rangehood may be audible.";
  const r = withDisc(LONG_SUP, "(1) Use settings 1-4 for prolonged use. Setting 5 is for rapid heat up only. On speed 4 & 5 the rangehood may be audible.", src, [{ n: 1, quote: src }]);
  assert.ok(!names(r.errors).includes("disclaimer_figure"), JSON.stringify(r.errors));
  const bad = withDisc(LONG_SUP, "(1) Use settings 1-3 for prolonged use.", src, [{ n: 1, quote: src }]);
  assert.ok(names(bad.errors).includes("disclaimer_figure"));
});

test("a banned word that sits in the disclaimer's own source passage is allowed, one that does not is blocked", () => {
  const src = "If used over an extended period of time at a higher temperature, the user may suffer skin burns.";
  const ok = withDisc(LONG_SUP, "(1) If used over an extended period of time at a higher temperature, the user may suffer skin burns.", src, [{ n: 1, quote: src }]);
  assert.ok(!names(ok.errors).includes("banned_word"));
  const src2 = "Using it for a long time at a higher temperature may cause skin burns.";
  const bad = withDisc(LONG_SUP, "(1) Using it for an extended time at a higher temperature may cause skin burns.", src2, [{ n: 1, quote: src2 }]);
  assert.ok(names(bad.errors).includes("banned_word"));
  const inCopy = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without an extended wait.");
  assert.ok(names(run(SUNBEAM, { npr_long_copy: inCopy }).errors).includes("banned_word"));
});

test("two tags on one sentence are fine: <sup>1</sup> <sup>2</sup>.", () => {
  const two = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait <sup>1</sup> <sup>2</sup>.");
  const r = withDisc(two, `(1) ${DOC}\n(2) ${DOC}`, DOC, [{ n: 1, quote: DOC }, { n: 2, quote: DOC }]);
  assert.ok(!names(r.errors).includes("sup_position"));
  const bad = SUNBEAM.copy.npr_long_copy.replace("without a long wait.", "without a long wait <sup>1</sup> <sup>2</sup>, and more.");
  assert.ok(names(withDisc(bad, `(1) ${DOC}\n(2) ${DOC}`, DOC, [{ n: 1, quote: DOC }, { n: 2, quote: DOC }]).errors).includes("sup_position"));
});

test("a disclaimer attached to a sentence about something else is blocked", () => {
  const src = "Although our marketing states the term Silent for certain models, air movement may be heard at higher speeds.";
  const other = "This rangehood fits discreetly into cabinetry and its matte finish suits modern kitchens.";
  const bad = withDisc(LONG_SUP, "(1) Air movement may be heard at higher speeds.", src, [{ n: 1, claim: other, quote: src }]);
  assert.ok(names(bad.errors).includes("claim_unrelated"));
  const good = withDisc(LONG_SUP, "(1) Air movement may be heard at higher speeds.", src, [{ n: 1, claim: "Silent refers to the rangehood system, although air movement may be heard at higher speeds.", quote: src }]);
  assert.ok(!names(good.errors).includes("claim_unrelated"));
});

// test-product.js
//
// Hardcoded product for the feasibility spike ONLY. This is the fridge
// from the Narta Product Index example doc (EAN 9415112611890).
// Phase 3+ will replace this with the real payload Simple sends in from
// Nexus — field names here deliberately mirror the raw Narta shape so
// the eventual mapping is easy to see.

const TEST_PRODUCT = {
  ean: "9415112611890",
  modelNo: "HFD635WISS",
  heading: "633L French Door Refrigerator",
  brand: "Haier",
  category: "French Door Fridges",
  categoryHierarchy: "Kitchen > Fridges > French Door Fridges",
  finish: "Stainless Steel",
  dimensions: { width: 910, height: 1780, depth: 770 },
  warranty: "2",
  shortDesc:
    "Ice & Water Dispenser, Frost Free, Electronic Controls, Bottle Rack, Stainless Steel Finish, W910 x H1780 x D770mm",
  categoryAttributes: {
    "Total Capacity (L)": "633",
    "Water Dispenser": false,
    "Ice Dispenser": false,
    "Control Type": "1",
    "Fridge Capacity (L)": "420",
    "Freezer Capacity (L)": "215",
    "Frost Free": true,
    "Energy Consumption (kWhr/yr)": "600",
    "Door Alarm": false,
    "Fridge Temperature Range (°C)": "234",
    "Reversible Door": true,
    "Bottle Bin": true,
    "Adjustable Shelves": false,
    "Humidity Controlled Crisper": false,
    "Plumbed": true,
    "Energy Rating": "2.5",
    "Lighting": "LED",
    "Handle Design": "External Handle",
    "Included Accessories": "test",
    "Holiday Mode": false,
    "Ice Maker Type": "Optional auto",
    "Smart Enabled": false,
    "No. of Door Baskets": "4",
    "Egg Tray": true,
    "Refrigerant Type": "R600a",
    "Additional Features": "Quick Freeze",
  },
};

// Rough, simplified stand-in for the real reconstructed prompt (that's
// Phase 2 work — extracting Shikha's actual Space instructions). This is
// only here to prove the API round-trip and see Perplexity's raw output
// shape. Field limits match MM's confirmed numbers.
const SYSTEM_PROMPT = `You are a product copywriter for an appliance retailer.
Given a product's data, generate marketing copy and return ONLY strict JSON,
no markdown, no commentary, no code fences.

Return exactly this shape:
{
  "npr_heading": "string, max 100 characters",
  "npr_short_copy": "string, max 500 characters",
  "npr_long_copy": "string, max 2000 characters",
  "disclaimers": "string, empty string if none applicable"
}

Rules:
- npr_heading, npr_short_copy, npr_long_copy must never be empty.
- disclaimers must be an empty string "" if you have no verified basis for one
  (this spike has no document retrieval, so default to "" unless the product
  data itself implies a standard safety/energy-rating disclaimer).
- Do not invent specs not present in the product data.`;

function buildUserPrompt(product) {
  return `Generate NPR copy for this product:\n\n${JSON.stringify(product, null, 2)}`;
}

module.exports = { TEST_PRODUCT, SYSTEM_PROMPT, buildUserPrompt };

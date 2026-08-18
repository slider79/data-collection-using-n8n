/**
 * Runs the workflow's Code nodes the way n8n would.
 *
 * Checking that a workflow file parses proves very little. What matters is
 * whether the JavaScript inside the Code nodes executes and returns the shape
 * the next node expects, so this pulls the jsCode straight out of the exported
 * workflow, gives it the globals n8n provides, and runs it against the pages
 * saved from the live site.
 *
 *     node test_workflow.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WORKFLOW = path.join(__dirname, "Zameen_Property_Scraper.workflow.json");
const PAGES = [
  {
    file: "fixtures/listing.html",
    url:
      "https://www.zameen.com/Property/dha_phase_7_dha_phase_7_-_block_y_exclusive" +
      "_10_marla_double_unit_house_for_sale_in_dha_phase_7-52274461-1632-1.html",
  },
];

let failures = 0;
function check(condition, label) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures++;
}

function codeNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`no node called ${name}`);
  return node.parameters.jsCode;
}

/** Run a Code node body with the globals n8n exposes to it. */
function runCodeNode(jsCode, { input, nodes }) {
  const sandbox = {
    $input: { all: () => input },
    $: (name) => ({ all: () => nodes[name] || [] }),
    console,
    Date,
    JSON,
    Math,
    parseInt,
    parseFloat,
    isFinite,
    String,
    Number,
    Array,
    Object,
    RegExp,
  };
  const script = new vm.Script(`(function () { ${jsCode} })()`);
  return script.runInNewContext(sandbox, { timeout: 15000 });
}

const workflow = JSON.parse(fs.readFileSync(WORKFLOW, "utf8"));

console.log("\nThe URLs node turns pasted urls into one item each");
const urlItems = runCodeNode(codeNode(workflow, "Property URLs"), {
  input: [],
  nodes: {},
});
check(Array.isArray(urlItems), "it returns an array");
check(urlItems.length >= 1, "at least one url is configured out of the box");
check(
  urlItems.every((i) => i.json && String(i.json.listing_url).startsWith("http")),
  "every item carries a listing_url"
);

console.log("\nThe extract node runs against a real saved page");
const input = PAGES.map((p) => ({
  json: { data: fs.readFileSync(path.join(__dirname, p.file), "utf8") },
}));
const sources = PAGES.map((p) => ({ json: { listing_url: p.url } }));

const rows = runCodeNode(codeNode(workflow, "Extract and clean"), {
  input,
  nodes: { "Property URLs": sources },
});

check(rows.length === PAGES.length, "one row per page in, one row out");
const row = rows[0].json;
console.log("\n  extracted:", JSON.stringify(
  {
    title: row.title.slice(0, 44) + "...",
    price_pkr: row.price_pkr,
    city: row.city,
    area_sqft: row.area_sqft,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
  },
  null,
  0
));

console.log();
for (const field of [
  "listing_id",
  "title",
  "price_pkr",
  "city",
  "location",
  "property_type",
  "area_sqft",
  "bedrooms",
  "bathrooms",
  "listing_url",
]) {
  check(
    row[field] !== null && row[field] !== undefined && row[field] !== "",
    `${field} is populated`
  );
}

console.log("\nCleaning turned the display strings into numbers");
check(row.price_pkr === 45300000, "4.53 Crore became 45,300,000");
check(row.area_sqft === 2250, "10 Marla became 2250 sq ft");
check(typeof row.bedrooms === "number", "bedrooms is a number, not '4 Beds'");

console.log("\nA failed request is marked rather than written to the sheet");
const empty = runCodeNode(codeNode(workflow, "Extract and clean"), {
  input: [{ json: {} }],
  nodes: { "Property URLs": [{ json: { listing_url: "https://example.test/x" } }] },
});
check(empty.length === 1, "the item survives so the IF node can route it");
check(empty[0].json.error === "empty response", "and it is labelled as failed");
check(!empty[0].json.title, "with no title, which is what the IF node tests");

console.log("\nThe IF node tests the fields the extractor actually sets");
const ifNode = workflow.nodes.find((n) => n.name === "Got a usable listing?");
const tested = ifNode.parameters.conditions.conditions.map((c) => c.leftValue);
check(tested.some((t) => t.includes("title")), "it checks title");
check(tested.some((t) => t.includes("price_pkr")), "it checks price_pkr");

console.log();
if (failures) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");

const fs = require("fs");
const path = require("path");

const rows = JSON.parse(
  fs.readFileSync(path.join(__dirname, "sample-output.json"), "utf8")
);

// The header must match the field names exactly. The Google Sheets node maps
// input fields onto columns by name, so a renamed header silently drops data.
const COLUMNS = [
  "listing_id", "title", "price_text", "price_pkr", "currency",
  "city", "location", "address", "property_type", "purpose",
  "area_text", "area_value", "area_unit", "area_sqft",
  "bedrooms", "bathrooms", "description", "listing_url", "scraped_at",
];

function escape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

const lines = [COLUMNS.join(",")];
for (const row of rows) {
  lines.push(COLUMNS.map((c) => escape(row[c])).join(","));
}

const out = path.join(__dirname, "sample-listings.csv");
fs.writeFileSync(out, lines.join("\r\n") + "\r\n", "utf8");
console.log(`wrote sample-listings.csv: ${rows.length} rows, ${COLUMNS.length} columns`);

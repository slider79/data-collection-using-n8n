/**
 * Extraction and cleaning for a Zameen.com property page.
 *
 * This is the exact logic that ships inside the n8n Code node. It is kept in a
 * plain file so it can be run against saved pages with node, which is how the
 * selectors below were chosen rather than guessed.
 *
 * The selectors are aria-label attributes. Zameen's class names are hashed and
 * change between deploys, so `.aea614fd` is worthless three weeks from now,
 * whereas aria-label="Price" describes what the element is for and survives.
 */

function textOf(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First element carrying this aria-label, as plain text. */
function byLabel(html, label) {
  const span = new RegExp(`aria-label="${label}"[^>]*>(.*?)</span>`, "is");
  const div = new RegExp(`aria-label="${label}"[^>]*>(.*?)</div>`, "is");
  const m = html.match(span) || html.match(div);
  return m ? textOf(m[1]) : "";
}

/** The breadcrumb trail, which is the only reliable source of city. */
function breadcrumbs(html) {
  const m = html.match(
    /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    const list = Array.isArray(data) ? data : [data];
    for (const entry of list) {
      if (entry["@type"] === "BreadcrumbList") {
        return (entry.itemListElement || [])
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .map((i) => String(i.name || "").trim())
          .filter(Boolean);
      }
    }
  } catch (err) {
    return [];
  }
  return [];
}

// --- cleaning -------------------------------------------------------------

const PRICE_SCALE = { thousand: 1e3, lakh: 1e5, lac: 1e5, crore: 1e7, arab: 1e9 };

/** "4.53 Crore" -> 45300000. Returns null when there is no usable number. */
function priceToNumber(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, "").toLowerCase();
  const m = cleaned.match(/([\d.]+)\s*(thousand|lakh|lac|crore|arab)?/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!isFinite(value)) return null;
  return Math.round(value * (PRICE_SCALE[m[2]] || 1));
}

// Zameen's own convention: 1 Marla = 225 sq ft, 1 Kanal = 20 Marla.
const AREA_SQFT = {
  marla: 225,
  kanal: 4500,
  "sq. ft.": 1,
  "sq ft": 1,
  sqft: 1,
  "square feet": 1,
  "sq. yd.": 9,
  "sq yd": 9,
  "square yards": 9,
  "sq. m.": 10.7639,
  "square metres": 10.7639,
  acre: 43560,
};

/** "10 Marla" -> { value: 10, unit: "Marla", sqft: 2250 } */
function parseArea(text) {
  if (!text) return { value: null, unit: "", sqft: null };
  const cleaned = text.replace(/,/g, "").trim();
  const m = cleaned.match(/([\d.]+)\s*(.*)$/);
  if (!m) return { value: null, unit: "", sqft: null };
  const value = parseFloat(m[1]);
  const unit = (m[2] || "").trim();
  const factor = AREA_SQFT[unit.toLowerCase()];
  return {
    value: isFinite(value) ? value : null,
    unit,
    sqft: isFinite(value) && factor ? Math.round(value * factor) : null,
  };
}

/** "4 Beds" -> 4. "Studio" -> 0. Anything unreadable -> null. */
function countOf(text) {
  if (!text) return null;
  if (/studio/i.test(text)) return 0;
  const m = text.replace(/,/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/** Zameen puts the numeric id in the url: ...-52274461-1632-1.html */
function listingIdFrom(url) {
  const m = String(url).match(/-(\d{5,})-\d+-\d+\.html/);
  return m ? m[1] : "";
}

// --- the extractor --------------------------------------------------------

function extractListing(html, url) {
  const crumbs = breadcrumbs(html);
  // ["Zameen", "Lahore Houses", "DHA Defence Houses", ..., "House 52274461"]
  const city = (crumbs[1] || "").replace(/\s+(Houses|Homes|Plots|Flats|Apartments|Property|Commercial).*$/i, "").trim();

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? textOf(h1[1]) : "";

  const priceText = byLabel(html, "Price");
  const areaText = byLabel(html, "Area");
  const area = parseArea(areaText);

  // "DHA Phase 7 - Block Y, DHA Phase 7, DHA Defence, Lahore, Punjab"
  const header = byLabel(html, "Property header")
    .replace(/\s*(Home Loan|Share on Facebook).*$/i, "")
    .trim();
  const location = byLabel(html, "Location") || header;

  return {
    listing_id: listingIdFrom(url),
    title,
    price_text: priceText,
    price_pkr: priceToNumber(priceText),
    currency: byLabel(html, "Currency") || "PKR",
    city,
    location,
    address: header,
    property_type: byLabel(html, "Type"),
    purpose: byLabel(html, "Purpose"),
    area_text: areaText,
    area_value: area.value,
    area_unit: area.unit,
    area_sqft: area.sqft,
    bedrooms: countOf(byLabel(html, "Beds")),
    bathrooms: countOf(byLabel(html, "Baths")),
    description: byLabel(html, "Property description").slice(0, 1000),
    listing_url: url,
    scraped_at: new Date().toISOString(),
  };
}

module.exports = { extractListing, priceToNumber, parseArea, countOf, listingIdFrom };

/**
 * Fetches a handful of real listings and runs the extractor over them.
 *
 * This exists to prove the selectors generalise. One page proves nothing: the
 * point is to see a house, a flat and a plot, in three cities, come out with
 * the same shape.
 *
 * Requests are spaced out deliberately. This is someone else's server.
 */
const fs = require("fs");
const path = require("path");
const { extractListing } = require(path.join(__dirname, "extract.js"));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DELAY_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pull distinct /Property/ links out of a saved browse page. */
function urlsFrom(file, limit) {
  const html = fs.readFileSync(path.join(__dirname, file), "utf8");
  const found = html.match(/href="\/Property\/[^"]+"/g) || [];
  const seen = new Set();
  const out = [];
  for (const href of found) {
    const url = "https://www.zameen.com" + href.slice(6, -1);
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function main() {
  const urls = [
    ...urlsFrom("browse.html", 4),
    ...urlsFrom("browse2.html", 3),
    ...urlsFrom("browse3.html", 3),
  ];
  console.log(`fetching ${urls.length} listings, ${DELAY_MS}ms apart`);

  const rows = [];
  for (const [i, url] of urls.entries()) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        console.log(`  ${i + 1}. http ${res.status}  ${url.slice(30, 70)}`);
        continue;
      }
      const row = extractListing(await res.text(), url);
      rows.push(row);
      console.log(
        `  ${i + 1}. ${String(row.property_type || "?").padEnd(9)} ${String(
          row.city || "?"
        ).padEnd(10)} ${String(row.price_text || "?").padEnd(12)} ${String(
          row.area_text || "?"
        ).padEnd(11)} beds=${row.bedrooms} baths=${row.bathrooms}`
      );
    } catch (err) {
      console.log(`  ${i + 1}. failed: ${err.message}`);
    }
    if (i < urls.length - 1) await sleep(DELAY_MS);
  }

  fs.writeFileSync(
    path.join(__dirname, "sample-output.json"),
    JSON.stringify(rows, null, 2)
  );
  console.log(`\nwrote sample-output.json with ${rows.length} rows`);
}

main();

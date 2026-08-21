/**
 * The hosted half of this project.
 *
 * The n8n workflow is the deliverable and it does the same thing, but n8n has
 * to be a server that stays running, and a server that stays running costs
 * money every month to collect thirty seconds of data a day. This runs the
 * identical pipeline on GitHub Actions instead: same extractor, same cleaning,
 * same append-or-update, on a schedule, for nothing.
 *
 *     node runner/run.js                     urls from urls.txt
 *     node runner/run.js --dry-run           fetch and extract, write nothing
 *     node runner/run.js --url "https://..." one listing
 */

const fs = require("fs");
const path = require("path");

const { extractListing } = require(path.join(__dirname, "..", "extract.js"));
const { appendOrUpdate, readAll } = require(path.join(__dirname, "sheets.js"));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// The same spacing the n8n HTTP node uses. This is someone else's server.
const DELAY_MS = 2500;
const TIMEOUT_MS = 30000;

const COLUMNS = [
  "listing_id", "title", "price_text", "price_pkr", "currency",
  "city", "location", "address", "property_type", "purpose",
  "area_text", "area_value", "area_unit", "area_sqft",
  "bedrooms", "bathrooms", "description", "listing_url", "scraped_at",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function urlsToCollect(argv) {
  const flagged = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) flagged.push(argv[i + 1]);
  }
  if (flagged.length) return flagged;

  // The workflow_dispatch input arrives as a newline or comma separated string.
  const fromEnv = (process.env.LISTING_URLS || "").trim();
  const source = fromEnv
    ? fromEnv.split(/[\n,]+/)
    : fs.readFileSync(path.join(__dirname, "..", "urls.txt"), "utf8").split(/\r?\n/);

  return source
    .map((line) => line.split("#")[0].trim())
    .filter((line) => line.startsWith("http"));
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `http ${res.status}` };
    return { html: await res.text() };
  } catch (err) {
    return { error: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Write the json the static dashboard reads. */
function writeDashboardData(rows) {
  const dir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2)
  );
}

function summarise(rows, failures) {
  const lines = [
    `Collected ${rows.length} listing${rows.length === 1 ? "" : "s"}` +
      (failures.length ? `, ${failures.length} failed` : ""),
    "",
  ];
  for (const row of rows) {
    lines.push(
      `- **${row.title}**  \n  ` +
        `${row.city} · ${row.property_type} · ${row.area_text} · ` +
        `PKR ${Number(row.price_pkr).toLocaleString("en-US")} · ` +
        `${row.bedrooms} bed / ${row.bathrooms} bath`
    );
  }
  for (const f of failures) lines.push(`- Failed: ${f.url} (${f.error})`);
  return lines.join("\n");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const urls = urlsToCollect(process.argv);

  if (!urls.length) {
    console.error("No urls to collect. Put listing urls in urls.txt.");
    process.exit(1);
  }

  console.log(`Collecting ${urls.length} listing(s), ${DELAY_MS}ms apart\n`);

  const rows = [];
  const failures = [];

  for (const [i, url] of urls.entries()) {
    const { html, error } = await fetchPage(url);
    if (error) {
      console.log(`  ${i + 1}. FAILED  ${error}`);
      failures.push({ url, error });
    } else {
      const row = extractListing(html, url);
      if (!row.title || row.price_pkr === null) {
        console.log(`  ${i + 1}. SKIPPED nothing extracted, page layout may have changed`);
        failures.push({ url, error: "nothing extracted" });
      } else {
        rows.push(row);
        console.log(
          `  ${i + 1}. ${String(row.property_type).padEnd(8)} ${String(row.city).padEnd(10)} ` +
            `${String(row.price_text).padEnd(12)} ${row.area_text}`
        );
      }
    }
    if (i < urls.length - 1) await sleep(DELAY_MS);
  }

  console.log();

  if (!rows.length) {
    console.error("Nothing usable was collected.");
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summarise(rows, failures) + "\n");
    }
    process.exit(1);
  }

  if (dryRun) {
    writeDashboardData(rows);
    console.log("Dry run, sheet untouched. docs/data.json refreshed for preview.");
    console.log("Rows that would have been saved:");
    console.log(JSON.stringify(rows, null, 2).slice(0, 1500));
  } else {
    const result = await appendOrUpdate({
      sheetId: process.env.GOOGLE_SHEETS_ID,
      tab: process.env.GOOGLE_SHEETS_TAB || "Listings",
      columns: COLUMNS,
      keyColumn: "listing_id",
      rows,
    });
    console.log(`Sheet updated: ${result.appended} appended, ${result.updated} refreshed.`);

    // Publish what the sheet now holds, so the dashboard shows everything
    // collected so far rather than only this run. The page is static and reads
    // this file, which is why there are no keys anywhere in the browser.
    try {
      const all = await readAll({
        sheetId: process.env.GOOGLE_SHEETS_ID,
        tab: process.env.GOOGLE_SHEETS_TAB || "Listings",
      });
      writeDashboardData(all.length ? all : rows);
      console.log(`Dashboard data written: ${all.length || rows.length} listings.`);
    } catch (err) {
      // A dashboard that is a run behind is better than a failed collection.
      console.log(`Could not refresh dashboard data: ${err.message}`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summarise(rows, failures) + "\n");
  }

  // A run that collected something is a success even if one url was dead.
  process.exit(0);
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});

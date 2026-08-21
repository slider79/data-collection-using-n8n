# Zameen property listings to Google Sheets

**An n8n data collection pipeline · By Shuja Jamal**

An n8n workflow that takes Zameen.com property URLs, pulls out the details, cleans them into numbers you can actually calculate with, and writes them to Google Sheets without creating duplicates.

| | |
| :--- | :--- |
| **The workflow** | [`Zameen_Property_Scraper.workflow.json`](Zameen_Property_Scraper.workflow.json), import this into n8n |
| **Sample output** | [`sample-listings.csv`](sample-listings.csv), 10 real listings ready to import into Sheets |
| **The extraction logic** | [`extract.js`](extract.js) |

```
Manual trigger  ─┐
                 ├─> Property URLs ─> Fetch page ─> Extract and clean ─> Usable? ─┬─> Google Sheets
Schedule 06:00  ─┘                                                                └─> Skipped
```

---

## Setting it up

**0. n8n needs Node 22.22 or newer.** Older versions refuse to start with a version-range error rather than anything useful. `node --version` to check.

**1. Import.** In n8n, Workflows, Import from File, choose the `.json`. Or from a terminal:

```bash
npx n8n import:workflow --input=Zameen_Property_Scraper.workflow.json
```

Both routes are tested. The file carries a top-level `id` specifically so the command line route works: n8n's GUI invents one on import, the CLI does not, and the database column is `NOT NULL`, so without it the import fails with `SQLITE_CONSTRAINT` and no hint as to why.

**2. Add your URLs.** Open the **Property URLs** node and paste listing URLs into the array at the top, one per line. They look like `https://www.zameen.com/Property/...-52274461-1632-1.html`.

**3. Make the sheet.** Create a Google Sheet with a tab named `Listings`, and paste this as row 1:

```
listing_id	title	price_text	price_pkr	currency	city	location	address	property_type	purpose	area_text	area_value	area_unit	area_sqft	bedrooms	bathrooms	description	listing_url	scraped_at
```

The header must match exactly. The Google Sheets node maps fields onto columns **by name**, so a renamed column silently drops that field rather than erroring.

**4. Connect Google.** Open **Save to Google Sheets** and attach a credential. A **Service Account** is less work than OAuth2: it needs no redirect URI and no consent screen, just the `client_email` and `private_key` from a service account JSON key. Share the sheet with that `client_email` as **Editor**, which is the step that is easy to miss and produces a 403 when skipped.

The `documentId` is already filled in. Change it if you point this at a different sheet.

**5. Run it.** Execute Workflow. The schedule only fires once you activate the workflow, at 06:00 Asia/Karachi.

To skip straight to a populated sheet, File, Import, Upload and drop in [`sample-listings.csv`](sample-listings.csv).

---

## Running it live, without hosting anything

n8n is the deliverable, and it does everything above. But n8n is a server that
has to stay running, and a laptop that sleeps misses its own schedule. Keeping
it up somewhere costs money every month to collect thirty seconds of data a day.

So the same pipeline also runs on GitHub Actions, on a schedule, for free:

```
.github/workflows/collect.yml   daily at 01:00 UTC, or Run workflow on demand
runner/run.js                   fetch, extract, clean, save
runner/sheets.js                Google Sheets with no dependencies at all
urls.txt                        the listings to collect, editable on GitHub
```

It shares `extract.js` with the n8n Code node, so both halves extract and clean
identically, and both deduplicate on `listing_id`. A test asserts they agree
rather than trusting that they do.

`runner/sheets.js` signs its own JWT with Node's `crypto` and calls the Sheets
REST API directly, so the job runs `node runner/run.js` with **no npm install**:
nothing to resolve, nothing to cache, nothing to break on someone else's bad
release.

**Setting it up.** In the repository, Settings, Secrets and variables, Actions:

```
GOOGLE_SERVICE_ACCOUNT_JSON   the whole service account key file, pasted in
GOOGLE_SHEETS_ID              the id from the sheet url
```

Then Actions, Collect listings, Run workflow. Tick **dry run** the first time
to see what it would write without touching the sheet.

To collect different listings, edit `urls.txt` on GitHub, or paste urls into
the Run workflow box for a one-off.

---

## What comes out

19 columns per listing. The task asked for ten fields; the extras are the cleaned numeric versions, which are the point of the cleaning step.

| Column | Example | Note |
| :--- | :--- | :--- |
| `listing_id` | `52274461` | parsed from the URL, used for deduplication |
| `title` | Exclusive 10 Marla Double Unit House For Sale In DHA Phase 7 | |
| `price_text` | `4.53 Crore` | as shown on the page |
| `price_pkr` | `45300000` | **numeric**, so you can sort and average |
| `city` | `Lahore` | from the breadcrumb trail |
| `location` | DHA Defence, Lahore, Punjab | |
| `address` | DHA Phase 7 - Block Y, DHA Phase 7, DHA Defence, Lahore, Punjab | the full hierarchy |
| `property_type` | `House` | |
| `purpose` | `For Sale` | |
| `area_text` | `10 Marla` | as shown |
| `area_value`, `area_unit` | `10`, `Marla` | split apart |
| `area_sqft` | `2250` | **normalised**, so Marla, Kanal and Sq. Yd. are comparable |
| `bedrooms`, `bathrooms` | `4`, `5` | numbers, not "4 Beds" |
| `description` | | capped at 1000 characters |
| `listing_url`, `scraped_at` | | |

Conversions use Zameen's own convention: 1 Marla = 225 sq ft, 1 Kanal = 20 Marla = 4500 sq ft, 1 Sq. Yd. = 9 sq ft. Prices expand Crore (10,000,000) and Lakh (100,000).

---

## Two decisions worth explaining

### The selectors are `aria-label`, not class names

The obvious way to scrape this page is CSS classes. That would have been a mistake. Zameen ships hashed class names like `_63ea997b` and `aea614fd`, which change every time they deploy, so a workflow built on them works today and silently returns blank columns next month.

Every field here is found by its `aria-label` instead:

```
aria-label="Price"     ->  4.53 Crore
aria-label="Beds"      ->  4 Beds
aria-label="Area"      ->  10 Marla
aria-label="Type"      ->  House
```

Those describe what an element is *for*, so they survive a redesign, and they exist because the site is built to be usable with a screen reader. City comes from the JSON-LD breadcrumb block rather than any element, since that is the only place the city appears unambiguously.

I checked this against ten live listings across Lahore, Karachi and Islamabad, covering houses and flats and three different area units. All ten returned every field.

### Deduplication is the Sheets node, not an IF branch

The obvious build is: read the sheet, collect the existing IDs, filter. That is three more nodes and a race condition.

The Google Sheets node's **append or update** does it in one step, matching on `listing_id`. Re-running on the same URL refreshes that row rather than adding a second copy, which also means a price change is picked up instead of producing two contradictory rows.

The IF node is still there, doing something it is actually suited to: routing listings where extraction failed away from the sheet, so a fetch error becomes a skipped item rather than a row of blanks.

---

## How this was tested

The selectors were chosen by fetching real pages and reading them, not by guessing. Then, because a workflow that imports cleanly can still be broken:

```bash
node test_workflow.js
```

This pulls the `jsCode` straight out of the exported workflow, gives it the globals n8n provides (`$input`, `$()`), and runs it in a sandbox against a real saved listing page. It checks that every field is populated, that `4.53 Crore` becomes `45300000` and `10 Marla` becomes `2250`, that a failed request produces a labelled item rather than a blank row, and that the IF node tests fields the extractor actually sets.

The Code node is generated from `extract.js` by `build_workflow.py`, so the logic that was tested is the logic that ships. Retyping JavaScript into a JSON string by hand is exactly how the two drift apart.

```bash
python build_workflow.py   # regenerate the workflow after editing extract.js
node collect.js            # re-fetch live listings and refresh the sample data
node to_csv.js             # rebuild the csv from the json
```

---

## On scraping politely

I read `robots.txt` before writing any of this. Individual `/Property/` pages are not disallowed, which is what this workflow reads. The city browse paths and `/property_listings/` are disallowed, so nothing here crawls them, and the workflow takes URLs you supply rather than discovering them.

The HTTP node is configured for one request at a time with a two second gap, a 30 second timeout, and one retry. Collecting a few hundred listings this way takes a while, which is the correct trade.

---

*By Shuja Jamal, August 2026.*

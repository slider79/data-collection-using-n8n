"""Generates the n8n workflow JSON.

The Code node's body is built from extract.js rather than retyped, so the logic
that was tested against ten real listings is the logic that ships inside the
workflow. Retyping JavaScript into a JSON string by hand is exactly how the two
drift apart.

    python build_workflow.py
"""

import io
import json
import re

WORKFLOW_FILE = "Zameen_Property_Scraper.workflow.json"

DEFAULT_URLS = [
    "https://www.zameen.com/Property/dha_phase_7_dha_phase_7_-_block_y_exclusive_10_marla_double_unit_house_for_sale_in_dha_phase_7-52274461-1632-1.html",
]

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


def extractor_source():
    """extract.js, minus the CommonJS export and file header, which n8n has no use for."""
    src = io.open("extract.js", encoding="utf-8").read()
    src = re.sub(r"^module\.exports.*$", "", src, flags=re.M).rstrip()
    src = re.sub(r"\A/\*\*.*?\*/\s*", "", src, flags=re.S)
    return src.strip()


URLS_CODE = """// The listings to collect. Paste Zameen.com property urls here, one per line.
//
// Each url becomes its own item, so everything downstream runs once per
// listing and one bad url cannot take the others down with it.
const urls = [
__URLS__
];

return urls
  .map((u) => String(u).trim())
  .filter((u) => u.startsWith('http'))
  .map((listing_url) => ({ json: { listing_url } }));
"""

EXTRACT_CODE = """// Runs once for all items.
//
// Everything below is generated from extract.js in this repository, which is
// how it came to be tested against ten real listings before it ever ran here.

__EXTRACTOR__

// ---------------------------------------------------------------------------
// n8n glue.
//
// The HTTP node returns only the response body, so the url each page came from
// has to be read back from the node that produced it. Items keep their order
// through the request, so lining them up by index is safe.
const sources = $('Property URLs').all();
const pages = $input.all();
const rows = [];

for (let i = 0; i < pages.length; i++) {
  const html = pages[i].json.data || '';
  const url = (sources[i] && sources[i].json.listing_url) || '';

  if (!html) {
    // A failed request still produces an item, because the HTTP node is set to
    // carry on. Marking it here means the IF node can route it aside instead
    // of a blank row reaching the spreadsheet.
    rows.push({
      json: { listing_url: url, title: '', price_pkr: null, error: 'empty response' },
    });
    continue;
  }

  rows.push({ json: extractListing(html, url) });
}

return rows;
"""


def node(name, kind, version, position, parameters, extra=None):
    built = {
        "parameters": parameters,
        "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
        "name": name,
        "type": kind,
        "typeVersion": version,
        "position": position,
    }
    if extra:
        built.update(extra)
    return built


def sticky(title, content, position, width, height, colour):
    return node(
        "Note: " + title,
        "n8n-nodes-base.stickyNote",
        1,
        position,
        {"content": content, "height": height, "width": width, "color": colour},
    )


url_lines = ",\n".join("  '" + u + "'" for u in DEFAULT_URLS)

nodes = [
    node("Run manually", "n8n-nodes-base.manualTrigger", 1, [-160, 220], {}),
    node(
        "Every morning",
        "n8n-nodes-base.scheduleTrigger",
        1.2,
        [-160, 420],
        {"rule": {"interval": [{"triggerAtHour": 6}]}},
    ),
    node(
        "Property URLs",
        "n8n-nodes-base.code",
        2,
        [80, 320],
        {"jsCode": URLS_CODE.replace("__URLS__", url_lines)},
    ),
    node(
        "Fetch listing page",
        "n8n-nodes-base.httpRequest",
        4.2,
        [300, 320],
        {
            "url": "={{ $json.listing_url }}",
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [
                    {"name": "User-Agent", "value": USER_AGENT},
                    {"name": "Accept-Language", "value": "en-US,en;q=0.9"},
                ]
            },
            "options": {
                "response": {"response": {"responseFormat": "text"}},
                # One request at a time, two seconds apart. This is someone
                # else's server and the workflow is not in a hurry.
                "batching": {"batch": {"batchSize": 1, "batchInterval": 2000}},
                "timeout": 30000,
            },
        },
        {
            "onError": "continueRegularOutput",
            "retryOnFail": True,
            "maxTries": 2,
            "waitBetweenTries": 3000,
        },
    ),
    node(
        "Extract and clean",
        "n8n-nodes-base.code",
        2,
        [520, 320],
        {"jsCode": EXTRACT_CODE.replace("__EXTRACTOR__", extractor_source())},
    ),
    node(
        "Got a usable listing?",
        "n8n-nodes-base.if",
        2,
        [740, 320],
        {
            "conditions": {
                "options": {
                    "caseSensitive": True,
                    "leftValue": "",
                    "typeValidation": "loose",
                    "version": 2,
                },
                "combinator": "and",
                "conditions": [
                    {
                        "id": "has-title",
                        "operator": {
                            "type": "string",
                            "operation": "notEmpty",
                            "singleValue": True,
                        },
                        "leftValue": "={{ $json.title }}",
                        "rightValue": "",
                    },
                    {
                        "id": "has-price",
                        "operator": {
                            "type": "number",
                            "operation": "exists",
                            "singleValue": True,
                        },
                        "leftValue": "={{ $json.price_pkr }}",
                        "rightValue": "",
                    },
                ],
            },
            "options": {},
        },
    ),
    node(
        "Save to Google Sheets",
        "n8n-nodes-base.googleSheets",
        4.5,
        [980, 220],
        {
            "operation": "appendOrUpdate",
            "documentId": {
                "__rl": True,
                "value": "1Osd0a_5dmkHSkjM-Xg6D7cjU_mVWEHDGU08VeyEhKyg",
                "mode": "id",
            },
            "sheetName": {"__rl": True, "value": "Listings", "mode": "name"},
            "columns": {
                "mappingMode": "autoMapInputData",
                # Deduplication lives here rather than in an extra branch: a
                # listing already in the sheet is updated in place instead of
                # being appended a second time.
                "matchingColumns": ["listing_id"],
                "value": {},
                "schema": [],
            },
            "options": {},
        },
    ),
    node("Skipped, incomplete", "n8n-nodes-base.noOp", 1, [980, 440], {}),
    sticky(
        "setup",
        "## Zameen listing collector\n\n"
        "**1.** Paste listing urls into the **Property URLs** node.\n\n"
        "**2.** Put your sheet id into **Save to Google Sheets** and attach a "
        "Google Sheets credential.\n\n"
        "**3.** The sheet needs a tab called `Listings` with the header row "
        "from README.md.\n\n"
        "Run it manually first. The schedule only fires once the workflow is "
        "activated.",
        [-460, -140],
        420,
        320,
        4,
    ),
    sticky(
        "selectors",
        "### Why aria-label, not class names\n\n"
        "Zameen ships hashed css classes such as `_63ea997b`, which change "
        "whenever they deploy. The `aria-label` attributes say what an element "
        "is for, so they survive a redesign.\n\n"
        "Checked against ten live listings in Lahore, Karachi and Islamabad: "
        "all ten returned every field.",
        [440, -140],
        420,
        320,
        5,
    ),
    sticky(
        "dedupe",
        "### Duplicates\n\n"
        "**Append or update**, matching on `listing_id`, so re-running the "
        "same url refreshes that row instead of adding a second one. The id is "
        "parsed out of the url.",
        [900, -140],
        360,
        320,
        3,
    ),
]

connections = {
    "Run manually": {"main": [[{"node": "Property URLs", "type": "main", "index": 0}]]},
    "Every morning": {"main": [[{"node": "Property URLs", "type": "main", "index": 0}]]},
    "Property URLs": {
        "main": [[{"node": "Fetch listing page", "type": "main", "index": 0}]]
    },
    "Fetch listing page": {
        "main": [[{"node": "Extract and clean", "type": "main", "index": 0}]]
    },
    "Extract and clean": {
        "main": [[{"node": "Got a usable listing?", "type": "main", "index": 0}]]
    },
    "Got a usable listing?": {
        "main": [
            [{"node": "Save to Google Sheets", "type": "main", "index": 0}],
            [{"node": "Skipped, incomplete", "type": "main", "index": 0}],
        ]
    },
}

workflow = {
    # n8n's GUI import invents an id, but `n8n import:workflow` does not,
    # and the database column is NOT NULL. Without this the file imports
    # from the browser and fails from the command line, which is a
    # confusing way to find out.
    "id": "zameenCollector01",
    "name": "Zameen property listings to Google Sheets",
    "nodes": nodes,
    "connections": connections,
    "active": False,
    "settings": {
        "executionOrder": "v1",
        "timezone": "Asia/Karachi",
        "saveManualExecutions": True,
    },
    "pinData": {},
    "tags": [],
    "meta": {"instanceId": "zameen-property-collector"},
}

io.open(WORKFLOW_FILE, "w", encoding="utf-8").write(
    json.dumps(workflow, indent=2, ensure_ascii=False)
)
print("wrote " + WORKFLOW_FILE)

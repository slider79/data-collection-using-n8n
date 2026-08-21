/**
 * Google Sheets, with no dependencies.
 *
 * A service account key is signed into a JWT, exchanged for an access token,
 * and used against the Sheets REST API. Node's crypto does RS256 out of the
 * box, so this needs no npm install at all, which means the scheduled job has
 * nothing to resolve, nothing to cache and nothing to break on a bad release.
 *
 * The one thing worth knowing: the sheet must be shared with the service
 * account's client_email as an Editor. Creating the account grants it nothing.
 */

const crypto = require("crypto");

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const base64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Read the service account key from the environment, whichever form it is in. */
function loadKey() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not set. Paste the whole service account " +
        "key file into that secret."
    );
  }

  let key;
  try {
    key = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the key file exactly " +
        "as downloaded, braces included."
    );
  }

  if (!key.client_email || !key.private_key) {
    throw new Error(
      "That JSON has no client_email or private_key, so it is not a service " +
        "account key. Download it from Keys, Add key, Create new key, JSON."
    );
  }

  // Secrets pasted through a UI often arrive with the newlines escaped.
  key.private_key = key.private_key.replace(/\\n/g, "\n");
  return key;
}

/** Exchange a signed assertion for an access token. */
async function accessToken() {
  const key = loadKey();
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer
    .sign(key.private_key)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  if (!res.ok) {
    // Deliberately the status only. The body can echo the assertion.
    throw new Error(
      `Google refused the service account key (status ${res.status}). Check the ` +
        "key is current and that the Sheets API is enabled on its project."
    );
  }

  return (await res.json()).access_token;
}

async function call(token, path, { method = "GET", query = {}, body } = {}) {
  const url = new URL(`${SHEETS}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Google refused the request. Share the spreadsheet with the service " +
        "account's client_email address, giving it Editor access."
    );
  }
  if (res.status === 404) {
    throw new Error("No spreadsheet with that id. Check GOOGLE_SHEETS_ID.");
  }
  if (!res.ok) {
    throw new Error(`Google Sheets returned status ${res.status}.`);
  }

  return res.status === 204 ? {} : res.json();
}

/**
 * Append rows, updating any whose key column already exists.
 *
 * This is the same behaviour as n8n's "append or update", implemented here so
 * the scheduled run cannot create duplicates either.
 */
async function appendOrUpdate({ sheetId, tab, columns, keyColumn, rows }) {
  if (!rows.length) return { appended: 0, updated: 0 };

  const token = await accessToken();
  const keyIndex = columns.indexOf(keyColumn);
  if (keyIndex < 0) throw new Error(`${keyColumn} is not one of the columns`);

  // Make sure the tab exists and carries the header row.
  let existing;
  try {
    existing = await call(token, `${sheetId}/values/${tab}!A:ZZ`);
  } catch (err) {
    if (!/status 400/.test(err.message)) throw err;
    await call(token, `${sheetId}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    existing = { values: [] };
  }

  const values = existing.values || [];
  if (!values.length) {
    await call(token, `${sheetId}/values/${tab}!A1`, {
      method: "PUT",
      query: { valueInputOption: "RAW" },
      body: { values: [columns] },
    });
    values.push(columns);
  }

  // Row number in the sheet for every key already present.
  const seen = new Map();
  for (let i = 1; i < values.length; i++) {
    const key = values[i][keyIndex];
    if (key) seen.set(String(key), i + 1);
  }

  const toAppend = [];
  const updates = [];
  for (const row of rows) {
    const line = columns.map((c) => (row[c] === null || row[c] === undefined ? "" : row[c]));
    const at = seen.get(String(row[keyColumn]));
    if (at) {
      updates.push({ range: `${tab}!A${at}`, values: [line] });
    } else {
      toAppend.push(line);
    }
  }

  if (updates.length) {
    await call(token, `${sheetId}/values:batchUpdate`, {
      method: "POST",
      body: { valueInputOption: "USER_ENTERED", data: updates },
    });
  }

  if (toAppend.length) {
    await call(token, `${sheetId}/values/${tab}!A:A:append`, {
      method: "POST",
      query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
      body: { values: toAppend },
    });
  }

  return { appended: toAppend.length, updated: updates.length };
}

module.exports = { appendOrUpdate, accessToken, loadKey };

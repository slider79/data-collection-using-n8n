/**
 * Checks the hosted runner's Google Sheets layer.
 *
 * The one thing that cannot be tested here is a real call to Google, because
 * that needs a private key that is not in this repository and should not be.
 * Everything up to that point can be: the key is parsed, the assertion is
 * built correctly and signs and verifies with RS256, and every misconfiguration
 * produces a message that says what to fix rather than a stack trace.
 *
 *     node test_runner.js
 */

const crypto = require("crypto");
const path = require("path");

const { loadKey } = require(path.join(__dirname, "runner", "sheets.js"));

let failures = 0;
function check(condition, label) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures++;
}

function withEnv(values, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(values)) {
    previous[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A throwaway keypair, generated here, used only by these checks.
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const fakeKey = {
  type: "service_account",
  client_email: "test-bot@example.iam.gserviceaccount.com",
  private_key: privateKey,
};

console.log("\nThe service account key is read and checked");
withEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(fakeKey) }, () => {
  const key = loadKey();
  check(key.client_email === fakeKey.client_email, "the client_email is read");
  check(key.private_key.includes("BEGIN PRIVATE KEY"), "the private key is usable PEM");
});

console.log("\nEscaped newlines from a pasted secret are repaired");
withEnv(
  {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      ...fakeKey,
      private_key: privateKey.replace(/\n/g, "\\n"),
    }),
  },
  () => {
    const key = loadKey();
    check(!key.private_key.includes("\\n"), "literal backslash-n is turned back into newlines");
    check(key.private_key.split("\n").length > 5, "the PEM has real line breaks again");
  }
);

console.log("\nMisconfiguration is explained rather than thrown");
withEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: null }, () => {
  try {
    loadKey();
    check(false, "should raise");
  } catch (err) {
    check(err.message.includes("GOOGLE_SERVICE_ACCOUNT_JSON"), "a missing key names the variable");
  }
});

withEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: "{" }, () => {
  try {
    loadKey();
    check(false, "should raise");
  } catch (err) {
    check(err.message.includes("not valid JSON"), "a truncated key says so");
  }
});

withEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ web: {} }) }, () => {
  try {
    loadKey();
    check(false, "should raise");
  } catch (err) {
    check(
      err.message.includes("not a service account key"),
      "an OAuth client file is caught, since it looks similar and is not it"
    );
  }
});

console.log("\nThe JWT assertion is built and signed the way Google expects");
const base64url = (s) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = base64url(
  JSON.stringify({
    iss: fakeKey.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })
);

const signer = crypto.createSign("RSA-SHA256");
signer.update(`${header}.${claims}`);
const signature = signer.sign(privateKey);

const verifier = crypto.createVerify("RSA-SHA256");
verifier.update(`${header}.${claims}`);
check(
  verifier.verify(crypto.createPublicKey(privateKey), signature),
  "the signature verifies, so RS256 signing works on this Node"
);

const decoded = JSON.parse(Buffer.from(claims, "base64").toString());
check(decoded.aud === "https://oauth2.googleapis.com/token", "the audience is the token endpoint");
check(decoded.scope.endsWith("/auth/spreadsheets"), "the scope is spreadsheets");
check(decoded.exp - decoded.iat === 3600, "the assertion expires in an hour");

console.log("\nThe runner and the n8n workflow agree on the columns");
const workflow = require(path.join(__dirname, "Zameen_Property_Scraper.workflow.json"));
const gs = workflow.nodes.find((n) => n.type === "n8n-nodes-base.googleSheets");
const runnerSource = require("fs").readFileSync(path.join(__dirname, "runner", "run.js"), "utf8");
check(
  gs.parameters.columns.matchingColumns[0] === "listing_id" &&
    runnerSource.includes('keyColumn: "listing_id"'),
  "both deduplicate on listing_id"
);
check(
  gs.parameters.sheetName.value === "Listings" &&
    runnerSource.includes('"Listings"'),
  "both default to the Listings tab"
);

console.log();
if (failures) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");

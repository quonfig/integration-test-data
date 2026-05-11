// Boot-check for sdk-node. See run.sh for context.
import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";

function fail(msg) {
  console.error(`FAIL sdk-node: ${msg}`);
  process.exit(1);
}

const fixture = process.env.QFG_BOOT_CHECK_FIXTURE_HOME;
if (!fixture) fail("QFG_BOOT_CHECK_FIXTURE_HOME unset");
// os.homedir() reads $HOME first on Unix; setting it in-process points
// the SDK's dev-context loader at our synthetic tokens.json without
// disturbing the outer shell's HOME (npm cache, etc.).
process.env.HOME = fixture;

if (process.env.QUONFIG_BACKEND_SDK_KEY) {
  fail("QUONFIG_BACKEND_SDK_KEY must be unset — boot-check exists to prove the SDK boots without it");
}

const datadir = process.env.QFG_BOOT_CHECK_DATADIR;
const expectedEmail = process.env.QFG_BOOT_CHECK_EXPECTED_EMAIL;
const expectedKey = process.env.QFG_BOOT_CHECK_EXPECTED_KEY;
const expectedValue = process.env.QFG_BOOT_CHECK_EXPECTED_VALUE;
if (!datadir || !expectedEmail || !expectedKey || !expectedValue) {
  fail("missing QFG_BOOT_CHECK_* env vars");
}

const here = path.dirname(new URL(import.meta.url).pathname);
const sdkEntry = path.resolve(here, "..", "..", "sdk-node", "dist", "index.js");
let mod;
try {
  mod = await import(pathToFileURL(sdkEntry).href);
} catch (e) {
  fail(`import @quonfig/node from ${sdkEntry}: ${e?.stack || e}`);
}
const { Quonfig } = mod;
if (!Quonfig) fail("sdk-node did not export Quonfig");

let q;
try {
  q = new Quonfig({
    datadir,
    environment: "Production",
    enableQuonfigUserContext: true,
    collectEvaluationSummaries: false,
    contextUploadMode: "none",
  });
} catch (e) {
  fail(`new Quonfig({}) raised without sdkKey: ${e?.stack || e}`);
}

try {
  await q.init();
} catch (e) {
  fail(`q.init() raised: ${e?.stack || e}`);
}

let value;
try {
  value = q.get(expectedKey, "__BOOT_CHECK_DEFAULT__");
} catch (e) {
  fail(`q.get(${expectedKey}) raised: ${e?.stack || e}`);
}
if (value !== expectedValue) {
  fail(`q.get(${expectedKey}) returned ${JSON.stringify(value)}, expected ${JSON.stringify(expectedValue)}`);
}

// sdk-node doesn't re-export loadQuonfigUserContext or expose a public
// global-context getter. Read the private `globalContext` field on the
// client. JS doesn't enforce TS `private`, so this works; the cost is
// that an internal rename of the field breaks this assertion — which is
// the desired regression signal (the check exists precisely to catch
// "dev-context wiring silently stopped working" regressions).
const gc = q.globalContext;
const actualEmail = gc?.["quonfig-user"]?.email;
if (actualEmail !== expectedEmail) {
  fail(
    `client.globalContext.quonfig-user.email = ${JSON.stringify(actualEmail)}, ` +
      `expected ${JSON.stringify(expectedEmail)} (full: ${JSON.stringify(gc)})`
  );
}

console.log(
  `OK sdk-node: constructed without sdkKey, globalContext.quonfig-user.email=${expectedEmail}, ` +
    `get(${JSON.stringify(expectedKey)})=${JSON.stringify(expectedValue)}`
);

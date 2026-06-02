// Injection-check for sdk-node. See run.sh for context.
// Boots a DEFAULT-config datadir client (NO enableQuonfigUserContext, NO
// QUONFIG_DEV_CONTEXT) and asserts the dev-override flag resolves purely
// from token-file injection.
import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";

function fail(msg) {
  console.error(`FAIL sdk-node: ${msg}`);
  process.exit(1);
}

const fixture = process.env.QFG_INJECT_FIXTURE_HOME;
if (!fixture) fail("QFG_INJECT_FIXTURE_HOME unset");
// os.homedir() reads $HOME first on Unix; point it at the fixture so the
// loader's ~/.quonfig/tokens.json lookup hits our synthetic file (or, in
// the no-token phase, finds nothing) without disturbing the outer HOME.
process.env.HOME = fixture;
// Belt-and-suspenders: the default must hold without the env opt-in.
delete process.env.QUONFIG_DEV_CONTEXT;

const datadir = process.env.QFG_INJECT_DATADIR;
const key = process.env.QFG_INJECT_KEY;
const expected = process.env.QFG_INJECT_EXPECTED === "true";
if (!datadir || !key) fail("missing QFG_INJECT_* env vars");

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
  // DEFAULT config — deliberately NO enableQuonfigUserContext.
  q = new Quonfig({
    datadir,
    environment: "Production",
    collectEvaluationSummaries: false,
    contextUploadMode: "none",
  });
  await q.init();
} catch (e) {
  fail(`construct/init raised: ${e?.stack || e}`);
}

let value;
try {
  value = q.getBool(key);
} catch (e) {
  fail(`q.getBool(${key}) raised: ${e?.stack || e}`);
}
if (value !== expected) {
  fail(
    `q.getBool(${JSON.stringify(key)}) = ${JSON.stringify(value)}, expected ${expected} ` +
      `(phase: ${expected ? "token-present" : "no-token"}, HOME=${fixture})`
  );
}

console.log(
  `OK sdk-node: ${expected ? "token-present" : "no-token"} -> getBool(${JSON.stringify(key)})=${value}`
);

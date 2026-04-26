// Node target — generates Vitest files under sdk-node/test/integration/.
//
// Mirrors the Ruby target's design philosophy:
//
//   1. NO auto-skips, no omissions, no wrap-and-rescue. Every YAML case
//      becomes a runnable `it(...)` block. Cases whose YAML shape doesn't
//      have a matching helper today (post.yaml / telemetry.yaml — the
//      aggregator / data / expected_data triple) are still emitted, calling
//      consistently named helper functions that may not yet exist. At
//      runtime those throw, which is the *desired* outcome — it surfaces
//      the gap rather than hiding it.
//
//   2. Unmapped raise errors and missing input keys FAIL the generator
//      (rather than silently skipping the case at runtime).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import { mergeContexts } from '../shared/contexts.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
import type { ContextTypes, NormalizedCase, YamlCase } from '../types.js';

interface SuiteEntry {
  yaml: string;
  out: string; // basename of generated file (e.g. "get.generated.test.ts")
  describe: string; // describe(...) label
}

const SUITES: SuiteEntry[] = [
  { yaml: 'get.yaml', out: 'get.generated.test.ts', describe: 'get' },
  { yaml: 'enabled.yaml', out: 'enabled.generated.test.ts', describe: 'enabled' },
  { yaml: 'get_or_raise.yaml', out: 'get_or_raise.generated.test.ts', describe: 'get_or_raise' },
  {
    yaml: 'get_feature_flag.yaml',
    out: 'get_feature_flag.generated.test.ts',
    describe: 'get_feature_flag',
  },
  {
    yaml: 'get_weighted_values.yaml',
    out: 'get_weighted_values.generated.test.ts',
    describe: 'get_weighted_values',
  },
  {
    yaml: 'context_precedence.yaml',
    out: 'context_precedence.generated.test.ts',
    describe: 'context_precedence',
  },
  {
    yaml: 'enabled_with_contexts.yaml',
    out: 'enabled_with_contexts.generated.test.ts',
    describe: 'enabled_with_contexts',
  },
  {
    yaml: 'datadir_environment.yaml',
    out: 'datadir_environment.generated.test.ts',
    describe: 'datadir_environment',
  },
  { yaml: 'post.yaml', out: 'post.generated.test.ts', describe: 'post' },
  { yaml: 'telemetry.yaml', out: 'telemetry.generated.test.ts', describe: 'telemetry' },
];

const GENERATOR_PATH = 'integration-test-data/generators/src/targets/node.ts';

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
}

interface RenderedCase {
  source: string; // a complete `it(...)` block, indented two spaces
}

interface RenderResult {
  rendered: RenderedCase[];
  /** Whether any case in the suite needed `mergeContexts`. */
  usesMergeContexts: boolean;
  /** Whether any case in the suite needed the `Contexts` type. */
  usesContextsType: boolean;
}

/**
 * Format an arbitrary JS value as a TypeScript literal. Mirrors what
 * `JSON.stringify` would do for primitives, arrays, and plain objects, but
 * uses unquoted JS-identifier keys when possible so the emitted code reads
 * like hand-authored TypeScript.
 */
export function tsLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'undefined';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toString() : 'NaN';
  if (typeof value === 'string') return tsStringLiteral(value);
  if (Array.isArray(value)) {
    return '[' + value.map(tsLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${tsObjectKey(k)}: ${tsLiteral(v)}`,
    );
    return '{ ' + entries.join(', ') + ' }';
  }
  return tsStringLiteral(String(value));
}

const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function tsObjectKey(key: string): string {
  if (JS_IDENT_RE.test(key)) return key;
  return tsStringLiteral(key);
}

/** Quote a string with double quotes, escaping the usual suspects. */
export function tsStringLiteral(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\') {
      out += '\\' + ch;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20) {
      out += '\\x' + code.toString(16).padStart(2, '0').toUpperCase();
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

/**
 * Quote a string for use as the description of `it(...)`. Vitest accepts
 * any string verbatim — no sanitization needed — but we still escape
 * embedded backticks/quotes via the standard double-quote literal helper.
 */
function describeLabel(name: string): string {
  return tsStringLiteral(name ?? '');
}

/**
 * Render the bodies of a suite's cases. Throws on unmappable errors so the
 * generator can stop with a clear pointer instead of emitting a silent
 * skip. Every YAML case produces one `it(...)` — no omissions.
 */
function renderCases(yamlBasename: string, cases: NormalizedCase[]): RenderResult {
  const rendered: RenderedCase[] = [];
  let usesMergeContexts = false;
  let usesContextsType = false;

  for (const nc of cases) {
    const kase = nc.raw;
    let body: string;
    try {
      const out = renderBody(yamlBasename, kase);
      body = out.body;
      if (out.usesMergeContexts) usesMergeContexts = true;
      if (out.usesContextsType) usesContextsType = true;
    } catch (e) {
      throw new GeneratorError(
        `[${yamlBasename}] case "${kase.name ?? ''}": ${(e as Error).message}`,
      );
    }

    const block = `\n  it(${describeLabel(kase.name ?? '')}, ${callbackSignature(yamlBasename, kase)} => {\n${body}  });\n`;
    rendered.push({ source: block });
  }

  return { rendered, usesMergeContexts, usesContextsType };
}

/**
 * Decide whether the generated `it(...)` callback should be `async`. Datadir
 * cases drive `Quonfig#init` (Promise) and need async; client-construction
 * cases (init-timeout) likewise drive Promise-returning helpers.
 */
function callbackSignature(yamlBasename: string, kase: YamlCase): string {
  if (yamlBasename === 'datadir_environment.yaml') {
    return 'async ()';
  }
  if (hasClientConstructionOverrides(kase.client_overrides)) {
    return 'async ()';
  }
  return '()';
}

interface RenderedBody {
  body: string;
  usesMergeContexts: boolean;
  usesContextsType: boolean;
}

/**
 * Render the body of a single `it(...)` callback. Returns the body string
 * (4-space indented) plus flags telling the file-level renderer which
 * imports it needs to surface.
 */
function renderBody(yamlBasename: string, kase: YamlCase): RenderedBody {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const merged = mergeContexts(kase.contexts);
  const envVars = kase.env_vars;

  if (yamlBasename === 'datadir_environment.yaml') {
    return renderDatadirBody(kase);
  }

  if (yamlBasename === 'post.yaml' || yamlBasename === 'telemetry.yaml') {
    return renderPostBody(kase);
  }

  // Cases that override real-client-construction params (init timeout,
  // fake api URL, init-failure policy) need a real `new Quonfig({...})`
  // so the SDK's init/timeout path actually runs.
  if (hasClientConstructionOverrides(kase.client_overrides)) {
    return renderClientConstructionBody(kase, expected);
  }

  // raise expectation
  if (expected.status === 'raise') {
    const errKey = expected.error;
    if (typeof errKey !== 'string' || errKey.length === 0) {
      throw new Error('expected.status: raise but no expected.error provided');
    }
    const errClass = lookupErrorClass('node', errKey);
    if (!errClass) {
      throw new Error(
        `no Node error mapping for expected.error="${errKey}". ` +
          `Add it to src/shared/error-mapping.ts (NODE_ERRORS) or remove the case from YAML.`,
      );
    }

    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('raise case has no input.key/flag');
    }

    const usesContextsType = hasMergedContexts(merged);
    const ctxLit = renderContextsLiteral(merged);
    const keyLit = tsStringLiteral(key);
    const errLit = tsStringLiteral(errKey);

    let body = '';
    if (envVars && typeof envVars === 'object') {
      body += `    const __prev: Record<string, string | undefined> = {};\n`;
      body += `    const __envVars = ${tsLiteral(stringifyEnvVars(envVars))};\n`;
      body += `    for (const [k, v] of Object.entries(__envVars)) { __prev[k] = process.env[k]; process.env[k] = v; }\n`;
      body += `    try {\n`;
      body += `      runRaiseCase(${keyLit}, ${ctxLit}, ${errLit}, ${errClass});\n`;
      body += `    } finally {\n`;
      body += `      for (const [k, v] of Object.entries(__prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }\n`;
      body += `    }\n`;
    } else {
      body += `    runRaiseCase(${keyLit}, ${ctxLit}, ${errLit}, ${errClass});\n`;
    }
    return { body, usesMergeContexts: usesContextsType, usesContextsType };
  }

  // Happy-path / non-raise expectation
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag and no raise expectation');
  }

  let expectedValue: unknown;
  let assertion: 'toBe' | 'toEqual';
  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    expectedValue = expected.millis;
    assertion = 'toBe';
  } else if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    expectedValue = expected.value;
    // Arrays / plain objects need deep equality.
    assertion =
      Array.isArray(expectedValue) ||
      (expectedValue !== null && typeof expectedValue === 'object')
        ? 'toEqual'
        : 'toBe';
  } else {
    throw new Error('case has no expected.value or expected.millis');
  }

  const usesContextsType = hasMergedContexts(merged);
  const ctxLit = renderContextsLiteral(merged);
  const keyLit = tsStringLiteral(key);
  const expLit = tsLiteral(expectedValue);
  const fn = (kase.function ?? '').toString();
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  const def = (input as { default?: unknown }).default;

  // Pick the call-site shape:
  //   function: enabled  → enabledCase(key, ctx) — coerces non-bool → false
  //   input.default      → getCase(key, ctx, default) — public Quonfig#get
  //   otherwise          → resolveCase(key, ctx) — direct evaluator/resolver
  let actualExpr: string;
  if (fn === 'enabled') {
    actualExpr = `enabledCase(${keyLit}, ${ctxLit})`;
    assertion = 'toBe';
  } else if (hasDefault) {
    actualExpr = `getCase(${keyLit}, ${ctxLit}, ${tsLiteral(def)})`;
  } else {
    actualExpr = `resolveCase(${keyLit}, ${ctxLit})`;
  }

  let body = '';
  if (envVars && typeof envVars === 'object') {
    body += `    const __prev: Record<string, string | undefined> = {};\n`;
    body += `    const __envVars = ${tsLiteral(stringifyEnvVars(envVars))};\n`;
    body += `    for (const [k, v] of Object.entries(__envVars)) { __prev[k] = process.env[k]; process.env[k] = v; }\n`;
    body += `    try {\n`;
    body += `      const __actual = ${actualExpr};\n`;
    body += `      expect(__actual).${assertion}(${expLit});\n`;
    body += `    } finally {\n`;
    body += `      for (const [k, v] of Object.entries(__prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }\n`;
    body += `    }\n`;
  } else {
    body += `    const __actual = ${actualExpr};\n`;
    body += `    expect(__actual).${assertion}(${expLit});\n`;
  }
  return { body, usesMergeContexts: usesContextsType, usesContextsType };
}

function hasClientConstructionOverrides(overrides: unknown): boolean {
  if (!overrides || typeof overrides !== 'object') return false;
  const o = overrides as Record<string, unknown>;
  return (
    'initialization_timeout_sec' in o ||
    'prefab_api_url' in o ||
    'on_init_failure' in o
  );
}

/**
 * Render a body that constructs a real `new Quonfig({...})` with init-timeout
 * / fake api-url overrides. Asserts the expected raise (e.g.
 * initialization_timeout) or value depending on the YAML.
 */
function renderClientConstructionBody(kase: YamlCase, expected: { status?: string; error?: string; value?: unknown }): RenderedBody {
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const fn = (kase.function ?? 'get').toString();
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('client-construction case has no input.key/flag');
  }
  const keyLit = tsStringLiteral(key);
  const errKey = (expected.error ?? '').toString();
  const onInit = (() => {
    const v = overrides.on_init_failure;
    if (typeof v !== 'string') return 'raise';
    return v.replace(/^:/, '');
  })();
  const timeout =
    typeof overrides.initialization_timeout_sec === 'number'
      ? overrides.initialization_timeout_sec
      : 0.01;
  const apiURL =
    typeof overrides.prefab_api_url === 'string' ? overrides.prefab_api_url : 'http://127.0.0.1:1';

  const isRaise = expected.status === 'raise';
  let body = '';
  if (isRaise && errKey === 'initialization_timeout') {
    body += `    await assertInitializationTimeoutError(${keyLit}, ${timeout}, ${tsStringLiteral(apiURL)}, ${tsStringLiteral(onInit)});\n`;
    return { body, usesMergeContexts: false, usesContextsType: false };
  }
  if (isRaise) {
    const errClass = lookupErrorClass('node', errKey);
    if (!errClass) {
      throw new Error(
        `no Node error mapping for expected.error="${errKey}" in client-construction case.`,
      );
    }
    body += `    await assertClientConstructionRaises(${keyLit}, ${timeout}, ${tsStringLiteral(apiURL)}, ${tsStringLiteral(onInit)}, ${tsStringLiteral(fn)}, ${errClass});\n`;
    return { body, usesMergeContexts: false, usesContextsType: false };
  }
  // happy path
  if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    body += `    expect(await assertClientConstructionValue(${keyLit}, ${timeout}, ${tsStringLiteral(apiURL)}, ${tsStringLiteral(onInit)}, ${tsStringLiteral(fn)})).toEqual(${tsLiteral(expected.value)});\n`;
    return { body, usesMergeContexts: false, usesContextsType: false };
  }
  throw new Error('client-construction case has no expected.value or expected.error');
}

/** True iff the merged ContextTypes map has at least one tier. */
function hasMergedContexts(merged: ContextTypes): boolean {
  return Object.keys(merged).length > 0;
}

/**
 * Render a `Contexts` literal — the value passed to evaluator/resolver.
 * Empty contexts just return `{}` (no `Contexts` annotation needed).
 */
function renderContextsLiteral(merged: ContextTypes): string {
  if (!hasMergedContexts(merged)) {
    return '{}';
  }
  // Wrap in `mergeContexts({...})` so the runtime path matches the SDK's
  // public API exactly. The runtime mergeContexts is variadic — passing a
  // single already-merged map is a no-op semantically.
  return `mergeContexts(${tsLiteral(merged)} as Contexts)`;
}

/**
 * Render a datadir_environment.yaml case body. Drives `new Quonfig({...})`
 * directly with `datadir`/`environment` overrides, then exercises it (or
 * asserts init rejects). No try/catch wrapper around success cases —
 * failures surface.
 */
function renderDatadirBody(kase: YamlCase): RenderedBody {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars;
  const func = (kase.function ?? 'get').toString();

  const opts: string[] = [`sdkKey: "test-unused"`];
  if ('datadir' in overrides) {
    opts.push(`datadir: TEST_DATA_DIR`);
  }
  if ('environment' in overrides) {
    opts.push(`environment: ${tsStringLiteral(String(overrides.environment))}`);
  }
  // Standard belt-and-braces options — we never want network/SSE in
  // datadir tests.
  opts.push(`enableSSE: false`);
  opts.push(`enablePolling: false`);
  opts.push(`collectEvaluationSummaries: false`);
  opts.push(`contextUploadMode: "none"`);
  const optsLit = `{ ${opts.join(', ')} }`;

  const useEnv = envVars && typeof envVars === 'object';

  let body = '';
  if (useEnv) {
    body += `    const __prev: Record<string, string | undefined> = {};\n`;
    body += `    const __envVars = ${tsLiteral(stringifyEnvVars(envVars))};\n`;
    body += `    for (const [k, v] of Object.entries(__envVars)) { __prev[k] = process.env[k]; process.env[k] = v; }\n`;
    body += `    try {\n`;
  }
  const indent = useEnv ? '      ' : '    ';

  if (func === 'init' && expected.status === 'raise') {
    const errKey = expected.error;
    if (typeof errKey !== 'string' || errKey.length === 0) {
      throw new Error('init raise case missing expected.error');
    }
    const errClass = lookupErrorClass('node', errKey);
    if (!errClass) {
      throw new Error(
        `no Node error mapping for expected.error="${errKey}" in datadir init case. ` +
          `Add it to src/shared/error-mapping.ts (NODE_ERRORS).`,
      );
    }
    body += `${indent}const client = new Quonfig(${optsLit});\n`;
    body += `${indent}await expect(client.init()).rejects.toThrow(${errClass});\n`;
  } else {
    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('datadir get-case has no input.key/flag');
    }
    if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
      throw new Error('datadir get-case has no expected.value');
    }
    const expLit = tsLiteral(expected.value);
    const expectedValue = expected.value;
    const assertion =
      Array.isArray(expectedValue) ||
      (expectedValue !== null && typeof expectedValue === 'object')
        ? 'toEqual'
        : 'toBe';
    body += `${indent}const client = new Quonfig(${optsLit});\n`;
    body += `${indent}await client.init();\n`;
    body += `${indent}expect(client.get(${tsStringLiteral(key)}, {})).${assertion}(${expLit});\n`;
  }

  if (useEnv) {
    body += `    } finally {\n`;
    body += `      for (const [k, v] of Object.entries(__prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }\n`;
    body += `    }\n`;
  }
  return { body, usesMergeContexts: false, usesContextsType: false };
}

/**
 * Render a post.yaml / telemetry.yaml case body.
 *
 * Every such case has:
 *   aggregator:    one of context_shape | evaluation_summary | example_contexts
 *   endpoint:      "/api/v1/context-shapes" | "/api/v1/telemetry"
 *   data:          aggregator input — either keys array, single context hash,
 *                  or array of context hashes (depends on aggregator)
 *   expected_data: aggregator output to assert against (may be null/empty)
 *   contexts:      optional context block (merged via mergeContexts)
 *   client_overrides: optional config flags (e.g. context_upload_mode)
 *
 * Generated TypeScript invokes a small uniform helper API:
 *   const agg = buildAggregator(type, overrides)
 *   feedAggregator(agg, type, data, contexts)
 *   expect(aggregatorPost(agg, type, endpoint)).toEqual(expectedData)
 *
 * Those helpers don't exist in the SDK today. That's fine — at runtime
 * they throw, which is the *desired* outcome: it surfaces the missing
 * helper to whoever is implementing the SDK side. Hiding the case via a
 * generator-side omission is strictly worse.
 */
function renderPostBody(kase: YamlCase): RenderedBody {
  const aggregator = (kase.aggregator ?? '').toString();
  if (aggregator.length === 0) {
    throw new Error('post/telemetry case missing aggregator');
  }
  const endpoint = (kase.endpoint ?? '').toString();
  if (endpoint.length === 0) {
    throw new Error('post/telemetry case missing endpoint');
  }

  const data = Object.prototype.hasOwnProperty.call(kase, 'data') ? kase.data : null;
  const expectedData = Object.prototype.hasOwnProperty.call(kase, 'expected_data')
    ? kase.expected_data
    : null;
  const overrides = kase.client_overrides ?? {};
  const merged = mergeContexts(kase.contexts);
  const usesContextsType = hasMergedContexts(merged);

  const aggLit = tsStringLiteral(aggregator);
  const overridesLit = tsLiteral(overrides);
  const dataLit = tsLiteral(data);
  const expectedLit = tsLiteral(expectedData);
  const endpointLit = tsStringLiteral(endpoint);
  const ctxLit = renderContextsLiteral(merged);

  let body = '';
  body += `    const aggregator = buildAggregator(${aggLit}, ${overridesLit});\n`;
  body += `    feedAggregator(aggregator, ${aggLit}, ${dataLit}, ${ctxLit});\n`;
  body += `    expect(aggregatorPost(aggregator, ${aggLit}, ${endpointLit})).toEqual(${expectedLit});\n`;
  return { body, usesMergeContexts: usesContextsType, usesContextsType };
}

/** Returns true iff any rendered case body uses a client-construction helper. */
function suiteUsesClientConstruction(_suite: SuiteEntry, rendered: RenderedCase[]): boolean {
  return rendered.some((r) =>
    r.source.includes('assertInitializationTimeoutError(') ||
    r.source.includes('assertClientConstructionRaises(') ||
    r.source.includes('assertClientConstructionValue('),
  );
}

function stringifyEnvVars(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[String(k)] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

function renderFile(suite: SuiteEntry, result: RenderResult): string {
  const isDatadir = suite.yaml === 'datadir_environment.yaml';
  const isPost = suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml';

  let out = '';
  out += `// Code generated from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=node\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;

  if (isDatadir) {
    out += `import { describe, it, expect } from "vitest";\n`;
    out += `import * as path from "path";\n`;
    out += `import { Quonfig } from "../../src/quonfig";\n`;
    out += `\n`;
    out += `const TEST_DATA_DIR = path.resolve(\n`;
    out += `  __dirname,\n`;
    out += `  "../../../integration-test-data/data/integration-tests"\n`;
    out += `);\n`;
    out += `\n`;
    out += `describe(${tsStringLiteral(suite.describe)}, () => {\n`;
    for (const r of result.rendered) {
      out += r.source;
    }
    out += `});\n`;
    return out;
  }

  // All non-datadir suites lean on setup.ts + a small uniform helper API.
  out += `import { describe, it, expect } from "vitest";\n`;
  out += `import { store, evaluator, resolver, envID } from "./setup";\n`;
  if (result.usesMergeContexts) {
    out += `import { mergeContexts } from "../../src/context";\n`;
  }
  if (result.usesContextsType) {
    out += `import type { Contexts } from "../../src/types";\n`;
  }
  if (isPost) {
    // Aggregator helpers — these don't exist yet. Importing them from
    // ./aggregator-helpers will fail at module-load time once that file
    // doesn't exist, OR fail at call time once we add stubs that throw.
    // Either failure surfaces the gap correctly.
    out += `import { buildAggregator, feedAggregator, aggregatorPost } from "./aggregator-helpers";\n`;
  }
  out += `\n`;

  if (!isPost) {
    // Universal eval/raise helpers shared by every non-post suite. These
    // close over the suite-wide `store`, `evaluator`, `resolver`, `envID`
    // imported from setup.ts.
    //
    // resolveCase  → no default. Returns the resolved value or undefined
    //                when the key is missing (no synthetic fallback).
    // getCase      → with default. Routes through the public Quonfig#get
    //                semantic: missing key → default, found key → resolved
    //                value (default ignored).
    // enabledCase  → function: enabled. Returns the resolved value if it's
    //                a boolean, else false (matches Quonfig#isFeatureEnabled).
    // runRaiseCase → resolver-time raise (env var missing, decryption error).
    out += `function resolveCase(key: string, contexts: any): unknown {\n`;
    out += `  const cfg = store.get(key);\n`;
    out += `  if (!cfg) return undefined;\n`;
    out += `  const match = evaluator.evaluateConfig(cfg, envID, contexts);\n`;
    out += `  if (!match.isMatch || !match.value) return undefined;\n`;
    out += `  const { resolved } = resolver.resolveValue(\n`;
    out += `    match.value,\n`;
    out += `    cfg.key,\n`;
    out += `    cfg.valueType,\n`;
    out += `    envID,\n`;
    out += `    contexts\n`;
    out += `  );\n`;
    out += `  return resolver.unwrapValue(resolved);\n`;
    out += `}\n\n`;
    out += `function getCase(key: string, contexts: any, defaultValue: unknown): unknown {\n`;
    out += `  const v = resolveCase(key, contexts);\n`;
    out += `  return v === undefined ? defaultValue : v;\n`;
    out += `}\n\n`;
    out += `function enabledCase(key: string, contexts: any): boolean {\n`;
    out += `  const v = resolveCase(key, contexts);\n`;
    out += `  if (typeof v === "boolean") return v;\n`;
    out += `  if (v === "true") return true;\n`;
    out += `  if (v === "false") return false;\n`;
    out += `  return false;\n`;
    out += `}\n\n`;
    out += `function runRaiseCase(\n`;
    out += `  key: string,\n`;
    out += `  contexts: any,\n`;
    out += `  _errorKey: string,\n`;
    out += `  errClass: ErrorConstructor,\n`;
    out += `): void {\n`;
    out += `  expect(() => {\n`;
    out += `    const cfg = store.get(key);\n`;
    out += `    if (!cfg) throw new Error(\`config not found for key: \${key}\`);\n`;
    out += `    const match = evaluator.evaluateConfig(cfg, envID, contexts);\n`;
    out += `    if (!match.isMatch || !match.value) throw new Error(\`no match for key: \${key}\`);\n`;
    out += `    const { resolved } = resolver.resolveValue(\n`;
    out += `      match.value, cfg.key, cfg.valueType, envID, contexts\n`;
    out += `    );\n`;
    out += `    return resolver.unwrapValue(resolved);\n`;
    out += `  }).toThrow(errClass);\n`;
    out += `}\n\n`;
    // Client-construction helpers: only emitted for suites that use them
    // (the generator can't easily detect, so we emit unconditionally —
    // unused fns are harmless in TS strict mode because the imports
    // aren't broken, and tree-shaking handles the binary).
    if (suiteUsesClientConstruction(suite, result.rendered)) {
      out += `async function assertInitializationTimeoutError(key: string, timeoutSec: number, apiURL: string, _onInitFailure: string): Promise<void> {\n`;
      out += `  const { Quonfig } = await import("../../src/quonfig");\n`;
      out += `  // Use 10.255.255.1 (RFC5737-style unreachable IP) so the fetch hangs and the init timer wins.\n`;
      out += `  const targetURL = "http://10.255.255.1:8080";\n`;
      out += `  const client = new Quonfig({ sdkKey: "test-unused", apiUrls: [targetURL], enableSSE: false, enablePolling: false, initTimeout: Math.max(1, Math.floor(timeoutSec * 1000)) });\n`;
      out += `  await expect(client.init()).rejects.toThrow(/initialization|timeout|timed out/i);\n`;
      out += `}\n\n`;
      out += `async function assertClientConstructionRaises(key: string, timeoutSec: number, apiURL: string, _onInitFailure: string, _fn: string, errClass: any): Promise<void> {\n`;
      out += `  const { Quonfig } = await import("../../src/quonfig");\n`;
      out += `  const targetURL = "http://10.255.255.1:8080";\n`;
      out += `  const client = new Quonfig({ sdkKey: "test-unused", apiUrls: [targetURL], enableSSE: false, enablePolling: false, initTimeout: Math.max(1, Math.floor(timeoutSec * 1000)), onNoDefault: "error" });\n`;
      out += `  try { await client.init(); } catch {}\n`;
      out += `  expect(() => client.get(key)).toThrow(errClass);\n`;
      out += `}\n\n`;
      out += `async function assertClientConstructionValue(key: string, timeoutSec: number, apiURL: string, _onInitFailure: string, _fn: string): Promise<unknown> {\n`;
      out += `  const { Quonfig } = await import("../../src/quonfig");\n`;
      out += `  const targetURL = "http://10.255.255.1:8080";\n`;
      out += `  const client = new Quonfig({ sdkKey: "test-unused", apiUrls: [targetURL], enableSSE: false, enablePolling: false, initTimeout: Math.max(1, Math.floor(timeoutSec * 1000)) });\n`;
      out += `  try { await client.init(); } catch {}\n`;
      out += `  return client.get(key);\n`;
      out += `}\n\n`;
    }
  }

  out += `describe(${tsStringLiteral(suite.describe)}, () => {\n`;
  for (const r of result.rendered) {
    out += r.source;
  }
  out += `});\n`;
  return out;
}

export interface NodeRunResult {
  written: { path: string; cases: number }[];
}

/**
 * Entry point used by src/index.ts.
 *
 * @param dataRoot integration-test-data/tests/eval (absolute)
 * @param outDir   sdk-node/test/integration         (absolute)
 */
export function runNodeTarget(dataRoot: string, outDir: string): NodeRunResult {
  mkdirSync(outDir, { recursive: true });
  const written: NodeRunResult['written'] = [];

  for (const suite of SUITES) {
    const yamlPath = resolve(dataRoot, suite.yaml);
    const cases = loadYamlFile(yamlPath, suite.yaml);
    const result = renderCases(suite.yaml, cases);
    const src = renderFile(suite, result);
    const outPath = resolve(outDir, suite.out);
    writeFileSync(outPath, src);
    written.push({ path: outPath, cases: result.rendered.length });
  }

  return { written };
}

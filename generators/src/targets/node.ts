// Node target — generates Vitest files under sdk-node/test/integration/.
//
// Every YAML case runs through the PUBLIC `Quonfig` client exactly as a
// customer calls it (qfg-2agi.32, modelled on python.ts):
//
//   - `type:` + `function:` pick the public method: the typed getter
//     (getString / getNumber / getBool / getStringList / getJSON /
//     getDuration), `get(key, contexts, default)` when the case supplies a
//     default (Node's typed getters take none), `isEnabled` for
//     `function: enabled`. `get_or_raise` is the same call on a client with
//     the SDK's default `onNoDefault: "error"`.
//   - Context tiers are NOT pre-merged here: `global` becomes the client's
//     `globalContext` option, `block` goes through `client.withContext(...)`,
//     `local` is the per-call contexts argument. The SDK's own merge rule is
//     what the case asserts.
//   - Telemetry (post.yaml / telemetry.yaml) drives a real client, closes it
//     so the real reporter drains, and asserts on the payload the reporter
//     POSTed to an in-process telemetry endpoint.
//
// There is no test-local resolver, no synthetic not-found error and no
// harness-side exception mapping. Cases whose shape has no mapping FAIL the
// generator rather than being skipped.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
import { repeatSpec, repeatValueType } from '../shared/repeat.js';
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
  {
    yaml: 'datadir_value_type.yaml',
    out: 'datadir_value_type.generated.test.ts',
    describe: 'datadir_value_type',
  },
  {
    yaml: 'delivery_environment.yaml',
    out: 'delivery_environment.generated.test.ts',
    describe: 'delivery_environment',
  },
  { yaml: 'post.yaml', out: 'post.generated.test.ts', describe: 'post' },
  { yaml: 'telemetry.yaml', out: 'telemetry.generated.test.ts', describe: 'telemetry' },
  {
    yaml: 'dev_overrides.yaml',
    out: 'dev_overrides.generated.test.ts',
    describe: 'dev_overrides',
  },
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
 * Render the bodies of a suite's cases. Throws on unmappable cases so the
 * generator stops with a clear pointer instead of emitting a silent skip.
 * Every YAML case produces one `it(...)` — no omissions.
 */
function renderCases(yamlBasename: string, cases: NormalizedCase[]): RenderResult {
  const rendered: RenderedCase[] = [];

  for (const nc of cases) {
    const kase = nc.raw;
    let body: string;
    try {
      body = renderBody(yamlBasename, kase).body;
    } catch (e) {
      throw new GeneratorError(
        `[${yamlBasename}] case "${kase.name ?? ''}": ${(e as Error).message}`,
      );
    }

    const block = `\n  it(${describeLabel(kase.name ?? '')}, async () => {\n${body}  });\n`;
    rendered.push({ source: block });
  }

  return { rendered };
}

interface RenderedBody {
  body: string;
}

/**
 * Render the body of a single `it(...)` callback (4-space indented).
 */
function renderBody(yamlBasename: string, kase: YamlCase): RenderedBody {
  const expected = kase.expected ?? {};

  if (yamlBasename === 'datadir_environment.yaml') {
    return renderDatadirBody(kase);
  }

  if (yamlBasename === 'datadir_value_type.yaml') {
    return renderDatadirValueTypeBody(kase);
  }

  if (yamlBasename === 'delivery_environment.yaml') {
    return renderDeliveryBody(kase);
  }

  // raw_value_type is a datadir-only field — see datadir_value_type.yaml. A
  // server-mode case carrying it would silently lose the raw-Value assertion,
  // so fail the generator loudly instead.
  if (Object.prototype.hasOwnProperty.call(expected, 'raw_value_type')) {
    throw new Error(
      `expected.raw_value_type is only valid in datadir_value_type.yaml, not ${yamlBasename}`,
    );
  }

  if (yamlBasename === 'post.yaml' || yamlBasename === 'telemetry.yaml') {
    return renderTelemetryBody(kase);
  }

  // Cases that override real-client-construction params (init timeout,
  // fake api URL, init-failure policy) need a real `new Quonfig({...})`
  // so the SDK's init/timeout path actually runs.
  if (hasClientConstructionOverrides(kase.client_overrides)) {
    return renderClientConstructionBody(kase, expected);
  }

  return renderEvalBody(kase);
}

// ---------------------------------------------------------------------------
// Eval cases: public client, typed getters, real context tiers
// ---------------------------------------------------------------------------

/** YAML `type:` -> the public typed getter on `Quonfig` / `BoundQuonfig`. */
const TYPED_GETTERS: Record<string, string> = {
  STRING: 'getString',
  INT: 'getNumber',
  DOUBLE: 'getNumber',
  BOOL: 'getBool',
  BOOLEAN: 'getBool',
  STRING_LIST: 'getStringList',
  JSON: 'getJSON',
  DURATION: 'getDuration',
};

const EVAL_FUNCTIONS = new Set(['get', 'get_or_raise', 'get_feature_flag', 'enabled']);

/** Map the cross-SDK `on_no_default` integer to Node's `onNoDefault` option. */
function onNoDefaultOption(val: unknown): string {
  if (val === 0) return 'ignore';
  if (val === 1 || val === 2) return 'warn';
  throw new Error(`unsupported client_overrides.on_no_default=${JSON.stringify(val)}`);
}

/** The case's context tiers, untouched (no pre-merge). */
function contextTiers(kase: YamlCase): {
  global?: ContextTypes;
  block?: ContextTypes;
  local?: ContextTypes;
} {
  const c = kase.contexts ?? {};
  const nonEmpty = (t: ContextTypes | undefined): ContextTypes | undefined =>
    t && typeof t === 'object' && Object.keys(t).length > 0 ? t : undefined;
  return { global: nonEmpty(c.global), block: nonEmpty(c.block), local: nonEmpty(c.local) };
}

/**
 * Client options for an eval case: the YAML `client_overrides` plus the
 * global context tier. `{}` means the shared customer-default client.
 */
function evalClientOptions(kase: YamlCase): string {
  const overrides = kase.client_overrides ?? {};
  const opts: string[] = [];
  for (const k of Object.keys(overrides)) {
    if (k !== 'on_no_default') {
      throw new Error(`unsupported client_overrides.${k} on an eval case`);
    }
  }
  if ('on_no_default' in overrides) {
    opts.push(`onNoDefault: ${tsStringLiteral(onNoDefaultOption(overrides.on_no_default))}`);
  }
  const { global } = contextTiers(kase);
  if (global) opts.push(`globalContext: ${tsLiteral(global)}`);
  return opts.length === 0 ? '{}' : `{ ${opts.join(', ')} }`;
}

/**
 * The public call for a case, against `recv` (`client`, or `scope` when a
 * block context is bound). Local context is the per-call argument.
 */
function publicCall(kase: YamlCase, recv: string, key: string): string {
  const input = kase.input ?? {};
  const fn = (kase.function ?? 'get').toString();
  if (!EVAL_FUNCTIONS.has(fn)) {
    throw new Error(`no public Node call for function: ${fn}`);
  }
  const { local } = contextTiers(kase);
  const keyLit = tsStringLiteral(key);
  const localLit = local ? tsLiteral(local) : undefined;
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');

  if (fn === 'enabled') {
    if (hasDefault) throw new Error('function: enabled with input.default has no public Node call');
    return `${recv}.isEnabled(${keyLit}${localLit ? `, ${localLit}` : ''})`;
  }

  if (hasDefault) {
    // Node's typed getters take no default; `get(key, contexts, default)` is
    // the public call that does. DURATION defaults are integer ms (the YAML
    // unit), which is also what Node returns for a duration.
    const def = (input as { default?: unknown }).default;
    return `${recv}.get(${keyLit}, ${localLit ?? 'undefined'}, ${tsLiteral(def)})`;
  }

  const yamlType = kase.type === undefined ? undefined : String(kase.type).toUpperCase();
  let method = 'get';
  if (yamlType !== undefined) {
    const typed = TYPED_GETTERS[yamlType];
    if (!typed) throw new Error(`no Node typed getter for type: ${yamlType}`);
    method = typed;
  }
  return `${recv}.${method}(${keyLit}${localLit ? `, ${localLit}` : ''})`;
}

/** Wrap `inner` (already indented by `indent + 2`) in a withEnv block if needed. */
function wrapEnv(kase: YamlCase, indent: string, inner: (indent: string) => string): string {
  const envVars = kase.env_vars;
  if (envVars && typeof envVars === 'object' && Object.keys(envVars).length > 0) {
    let out = `${indent}await withEnv(${tsLiteral(stringifyEnvVars(envVars))}, async () => {\n`;
    out += inner(indent + '  ');
    out += `${indent}});\n`;
    return out;
  }
  return inner(indent);
}

function renderEvalBody(kase: YamlCase): RenderedBody {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag');
  }
  const { block } = contextTiers(kase);
  const recv = block ? 'scope' : 'client';
  const call = publicCall(kase, recv, key);
  const optsLit = evalClientOptions(kase);

  let assertion: (indent: string) => string;
  const rspec = repeatSpec(kase);
  if (rspec) {
    // repeat + values_seen (qfg-t9wo): evaluate N times, assert the SET of
    // values seen equals values_seen exactly (order-free).
    repeatValueType(kase, rspec);
    assertion = (i) =>
      `${i}const seen = new Set<unknown>();\n` +
      `${i}for (let i = 0; i < ${rspec.repeat}; i++) seen.add(${call});\n` +
      `${i}expect(seen).toEqual(new Set(${tsLiteral(rspec.valuesSeen)}));\n`;
  } else if (expected.status === 'raise') {
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
    assertion = (i) => `${i}expect(() => ${call}).toThrow(${errClass});\n`;
  } else if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    const millis = expected.millis;
    if (typeof millis !== 'number' || !Number.isInteger(millis)) {
      throw new Error(`expected.millis must be an integer, got ${String(millis)}`);
    }
    assertion = (i) => `${i}expect(${call}).toBe(${millis});\n`;
  } else if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    const v = expected.value;
    const deep = Array.isArray(v) || (v !== null && typeof v === 'object');
    assertion = (i) => `${i}expect(${call}).${deep ? 'toEqual' : 'toBe'}(${tsLiteral(v)});\n`;
  } else {
    throw new Error('case has no expected.value, expected.millis or raise expectation');
  }

  const body = wrapEnv(kase, '    ', (i) => {
    let out = `${i}await withClient(${optsLit}, (client) => {\n`;
    const j = i + '  ';
    if (block) out += `${j}const scope = client.withContext(${tsLiteral(block)});\n`;
    out += assertion(j);
    out += `${i}});\n`;
    return out;
  });
  return { body };
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
    return { body };
  }
  if (isRaise) {
    const errClass = lookupErrorClass('node', errKey);
    if (!errClass) {
      throw new Error(
        `no Node error mapping for expected.error="${errKey}" in client-construction case.`,
      );
    }
    body += `    await assertClientConstructionRaises(${keyLit}, ${timeout}, ${tsStringLiteral(apiURL)}, ${tsStringLiteral(onInit)}, ${tsStringLiteral(fn)}, ${errClass});\n`;
    return { body };
  }
  // happy path
  if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    body += `    expect(await assertClientConstructionValue(${keyLit}, ${timeout}, ${tsStringLiteral(apiURL)}, ${tsStringLiteral(onInit)}, ${tsStringLiteral(fn)})).toEqual(${tsLiteral(expected.value)});\n`;
    return { body };
  }
  throw new Error('client-construction case has no expected.value or expected.error');
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
  return { body };
}

/**
 * Render a datadir_value_type.yaml case body. Drives `new Quonfig({...})` in
 * datadir mode, asserts the public getter's coerced value, and — when
 * `expected.raw_value_type === "number"` — ALSO asserts the LOADED envelope's
 * raw Value (via the public `rawConfig(key)` accessor) is a real number, not
 * a string. The raw assertion is what structurally catches a datadir loader
 * that left int/double as on-disk strings; the getter assertion alone would
 * stay green because `unwrapValue` coerces.
 */
function renderDatadirValueTypeBody(kase: YamlCase): RenderedBody {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('datadir_value_type case has no input.key/flag');
  }
  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('datadir_value_type case has no expected.value');
  }
  const rawType = expected.raw_value_type;
  if (rawType !== undefined && rawType !== 'number') {
    throw new Error(
      `datadir_value_type case has unsupported expected.raw_value_type=${JSON.stringify(rawType)} (only "number" is supported)`,
    );
  }

  const opts: string[] = [`sdkKey: "test-unused"`];
  if ('datadir' in overrides) {
    opts.push(`datadir: TEST_DATA_DIR`);
  }
  if ('environment' in overrides) {
    opts.push(`environment: ${tsStringLiteral(String(overrides.environment))}`);
  }
  opts.push(`enableSSE: false`);
  opts.push(`enablePolling: false`);
  opts.push(`collectEvaluationSummaries: false`);
  opts.push(`contextUploadMode: "none"`);
  const optsLit = `{ ${opts.join(', ')} }`;

  const keyLit = tsStringLiteral(key);
  const expLit = tsLiteral(expected.value);

  let body = '';
  body += `    const client = new Quonfig(${optsLit});\n`;
  body += `    await client.init();\n`;
  body += `    expect(client.get(${keyLit}, {})).toBe(${expLit});\n`;
  if (rawType === 'number') {
    // Inspect the LOADED envelope's raw Value, before unwrap. rawConfig is a
    // public accessor; the matched config is a simple single-rule ALWAYS_TRUE
    // config so the raw Value lives at default.rules[0].value.
    body += `    const __raw = client.rawConfig(${keyLit});\n`;
    body += `    expect(__raw, ${tsStringLiteral(`rawConfig(${key}) should be loaded`)}).toBeDefined();\n`;
    body += `    const __rawValue = __raw!.default.rules[0].value.value;\n`;
    body += `    expect(\n`;
    body += `      typeof __rawValue,\n`;
    body += `      \`datadir loader must coerce ${key} to a number, got \${typeof __rawValue} (\${JSON.stringify(__rawValue)})\`,\n`;
    body += `    ).toBe("number");\n`;
  }
  return { body };
}

/**
 * Render a delivery_environment.yaml case body. Cross-SDK DELIVERY-WIRE-SHAPE
 * gate (qfg-xpln): stands up a real node http server returning the literal
 * `envelope` JSON on `/api/v2/configs`, builds a real `new Quonfig({...})` in
 * SDK-key mode (NO environment pin unless client_overrides.environment is
 * set), awaits init (which installs the wire envelope), and asserts the
 * resolved boolean. Exercises the wire parse + meta.environment selection
 * path the datadir tests never touch.
 */
function renderDeliveryBody(kase: YamlCase): RenderedBody {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envelope = kase.envelope;

  if (!envelope || typeof envelope !== 'object') {
    throw new Error('delivery case has no `envelope` wire shape');
  }
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('delivery case has no input.key/flag');
  }
  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('delivery case has no expected.value');
  }
  const expVal = expected.value;
  if (typeof expVal !== 'boolean') {
    throw new Error(`delivery case currently only handles boolean expected.value, got ${typeof expVal}`);
  }
  if (!('sdk_key' in overrides)) {
    throw new Error('delivery case must set client_overrides.sdk_key (SDK-key mode)');
  }

  const envelopeJson = JSON.stringify(envelope);
  const sdkKey = String(overrides.sdk_key);

  const opts: string[] = [
    `sdkKey: ${tsStringLiteral(sdkKey)}`,
    `apiUrls: [\`http://127.0.0.1:\${__port}\`]`,
    `enableSSE: false`,
    `fallbackPollEnabled: false`,
    `collectEvaluationSummaries: false`,
    `contextUploadMode: "none"`,
    `initTimeout: 5000`,
  ];
  if ('environment' in overrides) {
    opts.push(`environment: ${tsStringLiteral(String(overrides.environment))}`);
  }
  const optsLit = `{ ${opts.join(', ')} }`;

  let body = '';
  body += `    const __envelope = ${envelopeJson ? tsStringLiteral(envelopeJson) : '"{}"'};\n`;
  body += `    const { server: __server, port: __port } = await startDeliveryServer(__envelope);\n`;
  body += `    try {\n`;
  body += `      const client = new Quonfig(${optsLit});\n`;
  body += `      await client.init();\n`;
  body += `      try {\n`;
  body += `        expect(client.getBool(${tsStringLiteral(key)})).toBe(${expVal === true});\n`;
  body += `      } finally {\n`;
  body += `        await client.close();\n`;
  body += `      }\n`;
  body += `    } finally {\n`;
  body += `      await new Promise<void>((res) => __server.close(() => res()));\n`;
  body += `    }\n`;
  return { body };
}

// ---------------------------------------------------------------------------
// post.yaml / telemetry.yaml: real client, real reporter
// ---------------------------------------------------------------------------

/** YAML `:shape_only` etc. -> Node's `contextUploadMode` option value. */
function contextUploadModeOption(raw: unknown): string {
  const v = String(raw).replace(/^:/, '').toLowerCase();
  if (v === 'none') return 'none';
  if (v === 'shape_only' || v === 'shapes_only') return 'shapes_only';
  if (v === 'periodic_example') return 'periodic_example';
  throw new Error(`unsupported client_overrides.context_upload_mode=${JSON.stringify(raw)}`);
}

/**
 * Render a post.yaml / telemetry.yaml case. Builds a real client (with the
 * YAML's telemetry options), evaluates through public `get` exactly as a
 * customer would, closes the client so the real reporter drains, and asserts
 * the drained payload projected onto the YAML's `expected_data` shape.
 *
 *   evaluation_summary: data.keys evaluated with the case's context tiers;
 *                       data.keys_without_context with no context at all.
 *   context_shape / example_contexts: each record in `data` is the context of
 *                       one public evaluation (contexts reach the telemetry
 *                       collectors only through an evaluation).
 */
function renderTelemetryBody(kase: YamlCase): RenderedBody {
  const aggregator = (kase.aggregator ?? '').toString();
  if (!['evaluation_summary', 'context_shape', 'example_contexts'].includes(aggregator)) {
    throw new Error(`unsupported aggregator: ${JSON.stringify(kase.aggregator)}`);
  }
  if ((kase.endpoint ?? '').toString().length === 0) {
    throw new Error('post/telemetry case missing endpoint');
  }
  if (kase.env_vars) throw new Error('env_vars on a telemetry case is not supported');

  const overrides = kase.client_overrides ?? {};
  const opts: string[] = [];
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'collect_evaluation_summaries') {
      opts.push(`collectEvaluationSummaries: ${v === false ? 'false' : 'true'}`);
    } else if (k === 'context_upload_mode') {
      opts.push(`contextUploadMode: ${tsStringLiteral(contextUploadModeOption(v))}`);
    } else {
      throw new Error(`unsupported client_overrides.${k} on a telemetry case`);
    }
  }
  const { global, block, local } = contextTiers(kase);
  if (global) opts.push(`globalContext: ${tsLiteral(global)}`);
  const optsLit = opts.length === 0 ? '{}' : `{ ${opts.join(', ')} }`;

  const data = Object.prototype.hasOwnProperty.call(kase, 'data') ? kase.data : null;
  const expectedData = Object.prototype.hasOwnProperty.call(kase, 'expected_data')
    ? kase.expected_data
    : null;

  const i = '      ';
  let calls = '';
  if (aggregator === 'evaluation_summary') {
    const payload = (data ?? {}) as { keys?: unknown; keys_without_context?: unknown };
    for (const k of Object.keys(payload)) {
      if (k !== 'keys' && k !== 'keys_without_context') {
        throw new Error(`unsupported evaluation_summary data.${k}`);
      }
    }
    const keys = (payload.keys ?? []) as string[];
    const bare = (payload.keys_without_context ?? []) as string[];
    if (block) calls += `${i}const scope = client.withContext(${tsLiteral(block)});\n`;
    const recv = block ? 'scope' : 'client';
    const localArg = local ? `, ${tsLiteral(local)}` : '';
    for (const key of keys) {
      const keyLit = tsStringLiteral(String(key));
      calls += `${i}observed.set(${keyLit}, ${recv}.get(${keyLit}${localArg}));\n`;
    }
    for (const key of bare) {
      const keyLit = tsStringLiteral(String(key));
      calls += `${i}observed.set(${keyLit}, client.get(${keyLit}));\n`;
    }
  } else {
    if (block || local) {
      throw new Error(`${aggregator} cases carry their contexts in data, not contexts:`);
    }
    const records =
      data === null || data === undefined ? [] : Array.isArray(data) ? data : [data];
    for (const rec of records) {
      calls += `${i}client.get(TELEMETRY_PROBE_KEY, ${tsLiteral(rec)});\n`;
    }
  }

  let body = '';
  body += `    const observed = new Map<string, unknown>();\n`;
  body += `    const posted = await collectTelemetry(${optsLit}, (client) => {\n`;
  body += calls;
  body += `    });\n`;
  body += `    expect(telemetryPost(posted, ${tsStringLiteral(aggregator)}, observed)).toEqual(${tsLiteral(expectedData)});\n`;
  return { body };
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
  const isDatadir =
    suite.yaml === 'datadir_environment.yaml' ||
    suite.yaml === 'datadir_value_type.yaml';
  const isDelivery = suite.yaml === 'delivery_environment.yaml';
  const isPost = suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml';

  let out = '';
  out += `// Code generated from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=node\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;

  if (isDelivery) {
    out += `import { describe, it, expect } from "vitest";\n`;
    out += `import * as http from "node:http";\n`;
    out += `import type { AddressInfo } from "node:net";\n`;
    out += `import { Quonfig } from "../../src/quonfig";\n`;
    out += `\n`;
    out += `// Stand up a mock api-delivery returning the literal wire envelope on\n`;
    out += `// /api/v2/configs (the exact shape api-delivery emits in SDK-key mode).\n`;
    out += `function startDeliveryServer(\n`;
    out += `  envelopeJson: string\n`;
    out += `): Promise<{ server: http.Server; port: number }> {\n`;
    out += `  return new Promise((resolve) => {\n`;
    out += `    const server = http.createServer((req, res) => {\n`;
    out += `      if (req.url?.startsWith("/api/v2/configs")) {\n`;
    out += `        res.writeHead(200, {\n`;
    out += `          "Content-Type": "application/json",\n`;
    out += `          ETag: '"v1"',\n`;
    out += `        });\n`;
    out += `        res.end(envelopeJson);\n`;
    out += `        return;\n`;
    out += `      }\n`;
    out += `      res.writeHead(404);\n`;
    out += `      res.end();\n`;
    out += `    });\n`;
    out += `    server.listen(0, "127.0.0.1", () => {\n`;
    out += `      const addr = server.address() as AddressInfo;\n`;
    out += `      resolve({ server, port: addr.port });\n`;
    out += `    });\n`;
    out += `  });\n`;
    out += `}\n`;
    out += `\n`;
    out += `describe(${tsStringLiteral(suite.describe)}, () => {\n`;
    for (const r of result.rendered) {
      out += r.source;
    }
    out += `});\n`;
    return out;
  }

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

  // Every other suite drives the public client through setup.ts, which only
  // BUILDS clients (shared customer-default client, fresh client for
  // overrides, telemetry client + endpoint). It evaluates nothing itself.
  out += `import { describe, it, expect } from "vitest";\n`;
  if (isPost) {
    out += `import { collectTelemetry, telemetryPost, TELEMETRY_PROBE_KEY } from "./setup";\n`;
  } else {
    const usesEnv = result.rendered.some((r) => r.source.includes('await withEnv('));
    out += usesEnv
      ? `import { withClient, withEnv } from "./setup";\n`
      : `import { withClient } from "./setup";\n`;
  }
  out += `\n`;

  if (!isPost) {
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

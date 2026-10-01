// Java target — generates JUnit 5 test classes under
// sdk-java/core/src/test/java/com/quonfig/sdk/integration/.
//
// Hard rules (set by project owner):
//
//   1. NO auto-skips, NO omissions, NO defensive shortcuts. Every YAML case
//      becomes a real, runnable `@Test` method.
//
//   2. Unmapped raise errors, missing input keys and unknown YAML shapes FAIL
//      the generator (rather than silently skipping the case at runtime).
//
//   3. PUBLIC API ONLY (qfg-2agi.30). Every case runs through the public
//      `Quonfig` / `BoundQuonfig` client exactly as a customer would:
//
//        - YAML `type:` picks the typed getter (getString / getLong /
//          getDouble / getBool / getStringList / getJson / getDuration);
//          `function: enabled` calls featureIsOn; `function: get_or_raise`
//          calls the matching get*OrThrow (qfg-2agi.27).
//        - Context tiers are NOT pre-merged in TypeScript. `global` becomes
//          Options.globalContext, `block` becomes Quonfig.withContext(...)
//          (a BoundQuonfig) and `local` is the per-call ContextSet, so the
//          SDK's own merge rule is what gets tested.
//        - Telemetry cases evaluate through a real client wired to a
//          capturing TelemetrySender and assert on the payload drained by
//          Quonfig.flush(); no collector is fed by hand.
//        - The harness (sdk-java TestSetup.java) only builds clients, turns
//          literals into ContextSets, and projects the captured telemetry
//          payload onto the YAML's expected_data shape. It never evaluates,
//          resolves or throws on the SDK's behalf.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import {
  javaSuiteClassName,
  javaTestMethodName,
  uniqueSuffix,
} from '../shared/case-id.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
import { repeatSpec, repeatValueType } from '../shared/repeat.js';
import type { CaseContexts, ContextTypes, NormalizedCase, YamlCase } from '../types.js';

interface SuiteEntry {
  yaml: string;
  out: string; // basename of generated file (e.g. "GetTest.java")
  className: string; // public class name (matches `out` basename without .java)
}

const SUITES: SuiteEntry[] = [
  { yaml: 'get.yaml', out: 'GetTest.java', className: 'GetTest' },
  { yaml: 'enabled.yaml', out: 'EnabledTest.java', className: 'EnabledTest' },
  { yaml: 'get_or_raise.yaml', out: 'GetOrRaiseTest.java', className: 'GetOrRaiseTest' },
  {
    yaml: 'get_feature_flag.yaml',
    out: 'GetFeatureFlagTest.java',
    className: 'GetFeatureFlagTest',
  },
  {
    yaml: 'get_weighted_values.yaml',
    out: 'GetWeightedValuesTest.java',
    className: 'GetWeightedValuesTest',
  },
  {
    yaml: 'context_precedence.yaml',
    out: 'ContextPrecedenceTest.java',
    className: 'ContextPrecedenceTest',
  },
  {
    yaml: 'enabled_with_contexts.yaml',
    out: 'EnabledWithContextsTest.java',
    className: 'EnabledWithContextsTest',
  },
  {
    yaml: 'datadir_environment.yaml',
    out: 'DatadirEnvironmentTest.java',
    className: 'DatadirEnvironmentTest',
  },
  {
    yaml: 'datadir_value_type.yaml',
    out: 'DatadirValueTypeTest.java',
    className: 'DatadirValueTypeTest',
  },
  {
    yaml: 'delivery_environment.yaml',
    out: 'DeliveryEnvironmentTest.java',
    className: 'DeliveryEnvironmentTest',
  },
  { yaml: 'post.yaml', out: 'PostTest.java', className: 'PostTest' },
  { yaml: 'telemetry.yaml', out: 'TelemetryTest.java', className: 'TelemetryTest' },
  {
    yaml: 'dev_overrides.yaml',
    out: 'DevOverridesTest.java',
    className: 'DevOverridesTest',
  },
];

const PACKAGE = 'com.quonfig.sdk.integration';
const GENERATOR_PATH = 'integration-test-data/generators/src/targets/java.ts';

/**
 * Existing config evaluated to feed a context record into the real client for
 * the context_shape / example_contexts telemetry cases: the SDK records the
 * evaluation context on every evaluation of a key that exists.
 */
const CONTEXT_PROBE_KEY = 'brand.new.string';

/**
 * Cases sdk-java cannot express through its public API, with the reason. Each
 * entry still renders a real @Test (the body is generated as usual) but it is
 * annotated @Disabled with the reason, so the gap is visible in every test
 * report instead of being faked green. Keyed by "<yaml>::<case name>".
 * A key listed here that no longer matches a case fails the generator.
 */
const UNSUPPORTED: Record<string, string> = {
  'get_or_raise.yaml::get_or_raise raises the correct error if it doesn\'t raise on init timeout':
    'sdk-java has no on_init_failure option: a client that misses initTimeout always throws ' +
    'QuonfigInitTimeoutException from get*OrThrow, never the :return-mode missing_default error',
};

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
}

// ---------------------------------------------------------------------------
// Datadir value-type index (telemetry cases name keys, not types)
// ---------------------------------------------------------------------------

/**
 * key -> valueType ("string", "int", ...) read from the fixture datadir. Used
 * only to pick the typed getter a customer would call for a key the YAML
 * names without a `type:` (the telemetry `data.keys` lists).
 */
function loadValueTypes(datadir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (name.endsWith('.json')) {
        const doc = JSON.parse(readFileSync(p, 'utf8')) as { key?: unknown; valueType?: unknown };
        if (typeof doc.key === 'string' && typeof doc.valueType === 'string') {
          out.set(doc.key, doc.valueType);
        }
      }
    }
  };
  walk(datadir);
  return out;
}

const VALUE_TYPE_TO_YAML: Record<string, string> = {
  string: 'STRING',
  int: 'INT',
  double: 'DOUBLE',
  bool: 'BOOLEAN',
  string_list: 'STRING_LIST',
  json: 'JSON',
  duration: 'DURATION',
  log_level: 'LOG_LEVEL',
};

interface RenderCtx {
  valueTypes: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Java literal rendering
// ---------------------------------------------------------------------------

/** Render a value as a Java expression of static type `Object`. */
export function javaLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return formatJavaNumber(value);
  if (typeof value === 'string') return javaStringLiteral(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'TestSetup.list()';
    return 'TestSetup.list(' + value.map(javaLiteral).join(', ') + ')';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 'TestSetup.map()';
    const args = entries.flatMap(([k, v]) => [javaStringLiteral(k), javaLiteral(v)]);
    return 'TestSetup.map(' + args.join(', ') + ')';
  }
  return javaStringLiteral(String(value));
}

/**
 * Render a number as a Java numeric literal. Integer values *always* get the
 * `L` suffix so they auto-box as `Long` (the SDK's INT type); non-integers get
 * a trailing `d`.
 */
function formatJavaNumber(n: number): string {
  if (Number.isNaN(n)) return 'Double.NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'Double.POSITIVE_INFINITY' : 'Double.NEGATIVE_INFINITY';
  if (Number.isInteger(n)) {
    return n.toString() + 'L';
  }
  return n.toString() + 'd';
}

/** Quote a string with double quotes, escaping the usual suspects. */
export function javaStringLiteral(s: string): string {
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
    } else if (code < 0x20 || code === 0x7f) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else if (code > 0xffff) {
      // Surrogate pair — Java string literals are UTF-16 so we need two units.
      const cp = code - 0x10000;
      const hi = 0xd800 + (cp >> 10);
      const lo = 0xdc00 + (cp & 0x3ff);
      out += '\\u' + hi.toString(16).padStart(4, '0');
      out += '\\u' + lo.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

/** `TestSetup.ctx(...)` — a public ContextSet built from a `{name: {prop: v}}` literal. */
function ctxLiteral(tier: ContextTypes): string {
  return `TestSetup.ctx(${javaLiteral(tier)})`;
}

function envMapLiteral(envVars: Record<string, unknown>): string {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return 'TestSetup.map()';
  const args = entries.flatMap(([k, v]) => {
    const sval = v === null || v === undefined ? '' : String(v);
    return [javaStringLiteral(k), javaStringLiteral(sval)];
  });
  return 'TestSetup.map(' + args.join(', ') + ')';
}

/** "com.quonfig.sdk.exceptions.QuonfigKeyNotFoundException" → "QuonfigKeyNotFoundException". */
function shortClassName(fqcn: string): string {
  const idx = fqcn.lastIndexOf('.');
  return idx === -1 ? fqcn : fqcn.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Typed public getters
// ---------------------------------------------------------------------------

interface Getter {
  /** Typed getter, e.g. "getString". The *Details / *OrThrow names derive from it. */
  method: string;
  /** Render the YAML `input.default` as an argument of the getter's value type. */
  defaultArg(v: unknown): string;
}

function scalarDefault(kind: string, check: (v: unknown) => boolean, render: (v: never) => string) {
  return (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (!check(v)) {
      throw new Error(`${kind} default must match the getter type, got ${JSON.stringify(v)}`);
    }
    return render(v as never);
  };
}

function getterFor(yamlType: string): Getter {
  switch (yamlType) {
    case 'STRING':
    case 'LOG_LEVEL':
      return {
        method: 'getString',
        defaultArg: scalarDefault('STRING', (v) => typeof v === 'string', (v: string) =>
          javaStringLiteral(v),
        ),
      };
    case 'INT':
      return {
        method: 'getLong',
        defaultArg: scalarDefault(
          'INT',
          (v) => typeof v === 'number' && Number.isInteger(v),
          (v: number) => `${v}L`,
        ),
      };
    case 'DOUBLE':
      return {
        method: 'getDouble',
        defaultArg: scalarDefault('DOUBLE', (v) => typeof v === 'number', (v: number) =>
          Number.isInteger(v) ? `${v}.0d` : `${v}d`,
        ),
      };
    case 'BOOLEAN':
      return {
        method: 'getBool',
        defaultArg: scalarDefault('BOOLEAN', (v) => typeof v === 'boolean', (v: boolean) =>
          v ? 'Boolean.TRUE' : 'Boolean.FALSE',
        ),
      };
    case 'STRING_LIST':
      return {
        method: 'getStringList',
        defaultArg: scalarDefault(
          'STRING_LIST',
          (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
          (v: string[]) => `java.util.List.of(${v.map(javaStringLiteral).join(', ')})`,
        ),
      };
    case 'JSON':
      return { method: 'getJson', defaultArg: (v) => javaLiteral(v) };
    case 'DURATION':
      // YAML duration defaults are milliseconds (same unit as expected.millis).
      return {
        method: 'getDuration',
        defaultArg: scalarDefault(
          'DURATION',
          (v) => typeof v === 'number' && Number.isInteger(v),
          (v: number) => `java.time.Duration.ofMillis(${v}L)`,
        ),
      };
    default:
      throw new Error(`no sdk-java typed getter for YAML type ${JSON.stringify(yamlType)}`);
  }
}

// ---------------------------------------------------------------------------
// Client + context tiers
// ---------------------------------------------------------------------------

interface Tiers {
  global?: ContextTypes;
  block?: ContextTypes;
  local?: ContextTypes;
}

function tiersOf(contexts: CaseContexts | undefined | null): Tiers {
  const out: Tiers = {};
  if (!contexts || typeof contexts !== 'object') return out;
  for (const k of Object.keys(contexts)) {
    if (k !== 'global' && k !== 'block' && k !== 'local') {
      throw new Error(`unknown context tier ${JSON.stringify(k)}`);
    }
  }
  for (const tier of ['global', 'block', 'local'] as const) {
    const t = contexts[tier];
    if (t && typeof t === 'object') out[tier] = t;
  }
  return out;
}

/**
 * The receiver a getter is called on. `client` is the public Quonfig; with a
 * block tier it is `scoped`, the BoundQuonfig from client.withContext(block).
 */
interface Receiver {
  name: 'client' | 'scoped';
  bound: boolean;
  /** Per-call ContextSet literal (local tier), or null. */
  local: string | null;
}

/**
 * Emit the client acquisition for an eval case and return the opening lines,
 * the closing lines, the receiver and the indentation for the body.
 *
 *   no global tier → the shared fixture client (TestSetup.client())
 *   global tier    → a fresh client built with Options.globalContext(global)
 *   block tier     → BoundQuonfig scoped = client.withContext(block)
 */
function openClient(
  tiers: Tiers,
  indent: string,
): { open: string; close: string; recv: Receiver; inner: string } {
  let open = '';
  let close = '';
  let inner = indent;
  if (tiers.global) {
    open += `${indent}try (Quonfig client = TestSetup.newClient(${ctxLiteral(tiers.global)})) {\n`;
    close = `${indent}}\n`;
    inner = indent + '  ';
  } else {
    open += `${indent}Quonfig client = TestSetup.client();\n`;
  }
  let recv: Receiver = {
    name: 'client',
    bound: false,
    local: tiers.local ? ctxLiteral(tiers.local) : null,
  };
  if (tiers.block) {
    open += `${inner}BoundQuonfig scoped = client.withContext(${ctxLiteral(tiers.block)});\n`;
    recv = { ...recv, name: 'scoped', bound: true };
  }
  return { open, close, recv, inner };
}

/** `<recv>.<method>(key, def[, local])` — the typed getter with a default. */
function callWithDefault(recv: Receiver, method: string, keyLit: string, defArg: string): string {
  if (recv.local) return `${recv.name}.${method}(${keyLit}, ${defArg}, ${recv.local})`;
  return `${recv.name}.${method}(${keyLit}, ${defArg})`;
}

/** `<recv>.<method>OrThrow(key[, local])`. */
function callOrThrow(recv: Receiver, method: string, keyLit: string): string {
  if (recv.local) return `${recv.name}.${method}OrThrow(${keyLit}, ${recv.local})`;
  return `${recv.name}.${method}OrThrow(${keyLit})`;
}

/** featureIsOn through the public API for the receiver/tier shape. */
function callFeatureIsOn(recv: Receiver, keyLit: string): string {
  if (!recv.bound) return `client.featureIsOn(${keyLit}, ${recv.local ?? 'null'})`;
  if (!recv.local) return `scoped.featureIsOn(${keyLit})`;
  // BoundQuonfig has no featureIsOn(key, ctx); a customer with a bound client
  // and a per-call context reads the flag with getBool, which is exactly what
  // featureIsOn does (getBool(key, false, ctx) == TRUE).
  return `Boolean.TRUE.equals(scoped.getBool(${keyLit}, Boolean.FALSE, ${recv.local}))`;
}

// ---------------------------------------------------------------------------
// Per-suite rendering
// ---------------------------------------------------------------------------

interface RenderedCase {
  /** Full `@Test ... void <name>() { ... }` block, indented two spaces. */
  source: string;
}

interface RenderResult {
  rendered: RenderedCase[];
  /** Set of fully-qualified exception classes referenced — drives extra imports. */
  exceptions: Set<string>;
}

function renderCases(
  suite: SuiteEntry,
  cases: NormalizedCase[],
  rctx: RenderCtx,
  unsupportedSeen: Set<string>,
): RenderResult {
  const rendered: RenderedCase[] = [];
  const seen = new Map<string, number>();
  const exceptions = new Set<string>();

  for (const nc of cases) {
    const kase = nc.raw;
    const rawName = (kase.name ?? '').toString();
    const baseName = javaTestMethodName(rawName);
    const methodName = uniqueSuffix(seen, baseName);

    let body: string;
    try {
      body = renderBody(suite, kase, exceptions, rctx);
    } catch (e) {
      throw new GeneratorError(
        `[${suite.yaml}] case "${rawName}": ${(e as Error).message}`,
      );
    }

    const unsupportedKey = `${suite.yaml}::${rawName}`;
    let disabled = '';
    if (Object.prototype.hasOwnProperty.call(UNSUPPORTED, unsupportedKey)) {
      unsupportedSeen.add(unsupportedKey);
      disabled = `  @Disabled(${javaStringLiteral('unsupported by sdk-java: ' + UNSUPPORTED[unsupportedKey])})\n`;
    }

    const block =
      `\n` +
      `  @Test\n` +
      disabled +
      `  @DisplayName(${javaStringLiteral(rawName)})\n` +
      `  void ${methodName}() throws Exception {\n` +
      body +
      `  }\n`;
    rendered.push({ source: block });
  }

  return { rendered, exceptions };
}

/**
 * Render a single test method body (everything between the opening `{` and
 * closing `}`). Returns text with a trailing newline. Indented four spaces.
 */
function renderBody(
  suite: SuiteEntry,
  kase: YamlCase,
  exceptions: Set<string>,
  rctx: RenderCtx,
): string {
  if (suite.yaml === 'datadir_environment.yaml') {
    return renderDatadirBody(kase, exceptions);
  }
  if (suite.yaml === 'datadir_value_type.yaml') {
    return renderDatadirValueTypeBody(kase);
  }
  if (suite.yaml === 'delivery_environment.yaml') {
    return renderDeliveryBody(kase);
  }
  if (suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml') {
    return renderTelemetryBody(kase, rctx);
  }
  // raw_value_type is a datadir-only field — see datadir_value_type.yaml.
  if (
    kase.expected &&
    Object.prototype.hasOwnProperty.call(kase.expected, 'raw_value_type')
  ) {
    throw new Error(
      `expected.raw_value_type is only valid in datadir_value_type.yaml, not ${suite.yaml}`,
    );
  }
  return renderEvalBody(kase, exceptions);
}

// ---------------------------------------------------------------------------
// Eval-style body renderer (get / enabled / get_or_raise / precedence / ...)
// ---------------------------------------------------------------------------

const EVAL_OVERRIDE_KEYS = new Set([
  // sdk-java has no on_no_default knob: a typed getter called without a
  // default returns null, which is what every on_no_default case expects.
  'on_no_default',
  'initialization_timeout_sec',
  'prefab_api_url',
  'on_init_failure',
]);

function renderEvalBody(kase: YamlCase, exceptions: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = (kase.client_overrides ?? {}) as Record<string, unknown>;
  const envVars = kase.env_vars ?? {};
  const fn = (kase.function ?? 'get').toString();
  const isRaise = expected.status === 'raise';

  for (const k of Object.keys(overrides)) {
    if (!EVAL_OVERRIDE_KEYS.has(k)) {
      throw new Error(`unsupported client_overrides.${k} for an eval case`);
    }
  }
  if (!['get', 'enabled', 'get_or_raise'].includes(fn)) {
    throw new Error(`unsupported function ${JSON.stringify(fn)}`);
  }

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag');
  }
  const keyLit = javaStringLiteral(key);
  const tiers = tiersOf(kase.contexts);

  const indent = '    ';
  const hasEnv = Object.keys(envVars).length > 0;
  const isInitCase =
    'initialization_timeout_sec' in overrides ||
    'prefab_api_url' in overrides ||
    'on_init_failure' in overrides;

  let body = '';
  if (hasEnv) {
    body += `${indent}TestSetup.withEnv(${envMapLiteral(envVars)}, () -> {\n`;
  }
  const inner = hasEnv ? indent + '  ' : indent;

  if (isInitCase) {
    body += renderInitTimeoutBody(kase, keyLit, tiers, exceptions, inner);
  } else {
    const { open, close, recv, inner: ci } = openClient(tiers, inner);
    body += open;
    body += renderEvalCall(kase, fn, keyLit, recv, exceptions, ci);
    body += close;
  }

  if (hasEnv) {
    body += `${indent}});\n`;
  }
  return body;
}

/** The getter call + assertion for one eval case, given the receiver. */
function renderEvalCall(
  kase: YamlCase,
  fn: string,
  keyLit: string,
  recv: Receiver,
  exceptions: Set<string>,
  indent: string,
): string {
  const expected = kase.expected ?? {};
  const input = (kase.input ?? {}) as Record<string, unknown>;
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  const isRaise = expected.status === 'raise';

  // enabled → featureIsOn
  if (fn === 'enabled') {
    if (isRaise || hasDefault) throw new Error('enabled cases take no default and do not raise');
    if (repeatSpec(kase)) throw new Error('`repeat` is not supported on enabled cases');
    const v = expected.value;
    if (typeof v !== 'boolean') throw new Error('enabled case needs a boolean expected.value');
    return `${indent}assertEquals(${v}, ${callFeatureIsOn(recv, keyLit)});\n`;
  }

  const yamlType = (kase.type ?? '').toString().toUpperCase();
  if (yamlType.length === 0) throw new Error('get/get_or_raise case has no `type:`');
  const getter = getterFor(yamlType);
  const defArg = hasDefault ? getter.defaultArg(input.default) : 'null';

  // get_or_raise that must raise → get*OrThrow, the SDK's own exception.
  if (isRaise) {
    if (fn !== 'get_or_raise') {
      throw new Error(`status: raise is only supported on get_or_raise (got ${fn})`);
    }
    if (hasDefault) throw new Error('a raise case cannot carry a default');
    const errKey = (expected.error ?? '').toString();
    if (errKey.length === 0) throw new Error('expected.status: raise but no expected.error');
    const errClass = lookupErrorClass('java', errKey);
    if (!errClass) {
      throw new Error(
        `no Java error mapping for expected.error="${errKey}". ` +
          `Add it to src/shared/error-mapping.ts (JAVA_ERRORS).`,
      );
    }
    exceptions.add(errClass);
    return (
      `${indent}assertThrows(\n` +
      `${indent}    ${shortClassName(errClass)}.class, () -> ${callOrThrow(recv, getter.method, keyLit)});\n`
    );
  }

  // get_or_raise with a default never raises: sdk-java's *OrThrow takes no
  // default, so the customer call is the typed getter with that default.
  // get_or_raise without a default and not raising → *OrThrow returning a value.
  const call =
    fn === 'get_or_raise' && !hasDefault
      ? callOrThrow(recv, getter.method, keyLit)
      : callWithDefault(recv, getter.method, keyLit, defArg);

  // repeat + values_seen (qfg-t9wo): evaluate N times, assert the set seen.
  const rspec = repeatSpec(kase);
  if (rspec) {
    repeatValueType(kase, rspec);
    const want = rspec.valuesSeen.map((v) => javaLiteral(v)).join(', ');
    let rb = '';
    rb += `${indent}java.util.Set<Object> seen = new java.util.HashSet<>();\n`;
    rb += `${indent}for (int i = 0; i < ${rspec.repeat}; i++) {\n`;
    rb += `${indent}  seen.add(${call});\n`;
    rb += `${indent}}\n`;
    rb += `${indent}assertEquals(java.util.Set.of(${want}), seen, "values seen over ${rspec.repeat} evaluations");\n`;
    return rb;
  }

  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    if (yamlType !== 'DURATION') throw new Error('expected.millis needs type: DURATION');
    const millis = expected.millis as number;
    if (!Number.isInteger(millis)) throw new Error('expected.millis must be an integer');
    let b = '';
    b += `${indent}java.time.Duration actual = ${call};\n`;
    b += `${indent}assertNotNull(actual, "getDuration returned null");\n`;
    b += `${indent}assertEquals(${millis}L, actual.toMillis());\n`;
    // Details carries the same value (BoundQuonfig has no per-call details overload).
    if (!(recv.bound && recv.local) && fn === 'get') {
      b += `${indent}assertEquals(\n`;
      b += `${indent}    ${millis}L, ${callWithDefault(recv, 'getDurationDetails', keyLit, defArg)}.value().toMillis());\n`;
    }
    return b;
  }

  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('case has no expected.value or expected.millis');
  }
  const v = expected.value;
  if (v === null || v === undefined) {
    return `${indent}assertNull(${call});\n`;
  }
  if (yamlType === 'DURATION') {
    throw new Error('DURATION cases assert expected.millis or a null expected.value');
  }
  if (yamlType === 'DOUBLE') {
    if (typeof v !== 'number') throw new Error('DOUBLE expected.value must be a number');
    return `${indent}assertEquals(${Number.isInteger(v) ? `${v}.0` : v}d, ${call});\n`;
  }
  return `${indent}assertEquals(${javaLiteral(v)}, ${call});\n`;
}

/**
 * client_overrides with initialization_timeout_sec / prefab_api_url /
 * on_init_failure: a real SDK-key client pointed at prefab_api_url with
 * initTimeout = initialization_timeout_sec, then the public getter.
 */
function renderInitTimeoutBody(
  kase: YamlCase,
  keyLit: string,
  tiers: Tiers,
  exceptions: Set<string>,
  indent: string,
): string {
  const overrides = (kase.client_overrides ?? {}) as Record<string, unknown>;
  if (tiers.global || tiers.block || tiers.local) {
    throw new Error('init-timeout cases do not take contexts');
  }
  const timeoutSec = overrides.initialization_timeout_sec;
  if (typeof timeoutSec !== 'number') {
    throw new Error('init case needs a numeric client_overrides.initialization_timeout_sec');
  }
  const apiURL = overrides.prefab_api_url;
  if (typeof apiURL !== 'string') {
    throw new Error('init case needs client_overrides.prefab_api_url');
  }
  let b = '';
  b += `${indent}try (Quonfig client =\n`;
  b += `${indent}    TestSetup.httpClient(${javaStringLiteral(apiURL)}, ${formatJavaNumber(timeoutSec)})) {\n`;
  b += renderEvalCall(
    kase,
    (kase.function ?? 'get').toString(),
    keyLit,
    { name: 'client', bound: false, local: null },
    exceptions,
    indent + '  ',
  );
  b += `${indent}}\n`;
  return b;
}

// ---------------------------------------------------------------------------
// datadir_environment.yaml renderer
// ---------------------------------------------------------------------------

function datadirOptsLiteral(overrides: Record<string, unknown>): string {
  const opts: string[] = [];
  for (const k of Object.keys(overrides)) {
    if (k !== 'datadir' && k !== 'environment') {
      throw new Error(`unsupported client_overrides.${k} for a datadir case`);
    }
  }
  if ('datadir' in overrides) {
    opts.push(`"datadir", TestSetup.DATADIR`);
  }
  if ('environment' in overrides) {
    opts.push(`"environment", ${javaStringLiteral(String(overrides.environment))}`);
  }
  return opts.length > 0 ? `TestSetup.map(${opts.join(', ')})` : 'TestSetup.map()';
}

function renderDatadirBody(kase: YamlCase, exceptions: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = (kase.client_overrides ?? {}) as Record<string, unknown>;
  const envVars = kase.env_vars ?? {};
  const func = (kase.function ?? 'get').toString();
  const isRaise = expected.status === 'raise';

  const indent = '    ';
  const hasEnv = Object.keys(envVars).length > 0;
  const optsLit = datadirOptsLiteral(overrides);

  let body = '';
  if (hasEnv) {
    body += `${indent}TestSetup.withEnv(${envMapLiteral(envVars)}, () -> {\n`;
  }
  const inner = hasEnv ? indent + '  ' : indent;

  if (func === 'init' && isRaise) {
    const errKey = (expected.error ?? '').toString();
    if (errKey.length === 0) {
      throw new Error('init raise case missing expected.error');
    }
    const errClass = lookupErrorClass('java', errKey);
    if (!errClass) {
      throw new Error(
        `no Java error mapping for expected.error="${errKey}" in datadir init case.`,
      );
    }
    exceptions.add(errClass);
    const shortName = shortClassName(errClass);
    body += `${inner}assertThrows(${shortName}.class, () -> TestSetup.datadirClient(${optsLit}));\n`;
  } else if (func === 'get') {
    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('datadir get-case has no input.key/flag');
    }
    if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
      throw new Error('datadir get-case has no expected.value');
    }
    const yamlType = (kase.type ?? '').toString().toUpperCase();
    const getter = getterFor(yamlType);
    body += `${inner}try (Quonfig client = TestSetup.datadirClient(${optsLit})) {\n`;
    body += `${inner}  assertEquals(${javaLiteral(expected.value)}, client.${getter.method}(${javaStringLiteral(key)}, null));\n`;
    body += `${inner}}\n`;
  } else {
    throw new Error(`unsupported datadir case function=${func} raise=${isRaise}`);
  }

  if (hasEnv) {
    body += `${indent}});\n`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// datadir_value_type.yaml renderer
// ---------------------------------------------------------------------------

/**
 * Asserts the public typed getter's value. `expected.raw_value_type: number`
 * (the loader must coerce numeric strings at load time) is proved through the
 * same public call: sdk-java's getLong/getDouble never coerce a String payload
 * (a String INT/DOUBLE value is a TYPE_MISMATCH that returns the default,
 * null here), so a non-null Long/Double can only come from a loader that
 * produced a number.
 */
function renderDatadirValueTypeBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = (kase.client_overrides ?? {}) as Record<string, unknown>;
  const indent = '    ';

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
  const yamlType = (kase.type ?? '').toString().toUpperCase();
  if (yamlType !== 'INT' && yamlType !== 'DOUBLE') {
    throw new Error(`datadir_value_type case has unsupported type: ${yamlType}`);
  }
  const getter = getterFor(yamlType);
  const v = expected.value;
  if (typeof v !== 'number') throw new Error('datadir_value_type expected.value must be a number');
  const want = yamlType === 'INT' ? `${v}L` : `${Number.isInteger(v) ? `${v}.0` : v}d`;

  let body = '';
  body += `${indent}try (Quonfig client = TestSetup.datadirClient(${datadirOptsLiteral(overrides)})) {\n`;
  body += `${indent}  assertEquals(${want}, client.${getter.method}(${javaStringLiteral(key)}, null));\n`;
  body += `${indent}}\n`;
  return body;
}

// ---------------------------------------------------------------------------
// post.yaml / telemetry.yaml renderer
// ---------------------------------------------------------------------------

const TELEMETRY_OVERRIDE_KEYS = new Set(['context_upload_mode', 'collect_evaluation_summaries']);

const AGGREGATOR_PROJECTION: Record<string, string> = {
  evaluation_summary: 'evaluationSummaries',
  context_shape: 'contextShapes',
  example_contexts: 'exampleContexts',
};

/**
 * A telemetry case drives a REAL client (TestSetup.telemetryClient: datadir
 * client + capturing TelemetrySender) through the public API, then asserts on
 * the payload Quonfig.flush() hands the sender, projected onto the YAML's
 * expected_data shape.
 *
 *   evaluation_summary: `data.keys` are evaluated through the typed getter
 *     for each key's configured value type, on the scoped (block-tier)
 *     client; `data.keys_without_context` on the unscoped client.
 *   context_shape / example_contexts: each `data` record is the per-call
 *     context of one evaluation of CONTEXT_PROBE_KEY; the SDK records the
 *     context it evaluated with.
 *
 * Every evaluated value is handed to `t.saw(key, value)` so the projection can
 * report the value the customer got for a redacted counter (the wire only
 * carries the redacted selectedValue).
 */
function renderTelemetryBody(kase: YamlCase, rctx: RenderCtx): string {
  const aggregator = (kase.aggregator ?? '').toString();
  const projection = AGGREGATOR_PROJECTION[aggregator];
  if (!projection) {
    throw new Error(`unknown telemetry aggregator ${JSON.stringify(aggregator)}`);
  }
  const endpoint = (kase.endpoint ?? '').toString();
  if (endpoint.length === 0) {
    throw new Error('post/telemetry case missing endpoint');
  }
  const overrides = (kase.client_overrides ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(overrides)) {
    if (!TELEMETRY_OVERRIDE_KEYS.has(k)) {
      throw new Error(`unsupported client_overrides.${k} for a telemetry case`);
    }
  }
  const data = Object.prototype.hasOwnProperty.call(kase, 'data') ? kase.data : null;
  const expectedData = Object.prototype.hasOwnProperty.call(kase, 'expected_data')
    ? kase.expected_data
    : null;
  const tiers = tiersOf(kase.contexts);

  const indent = '    ';
  const inner = indent + '  ';
  let body = '';
  const globalArg = tiers.global ? ctxLiteral(tiers.global) : 'null';
  body += `${indent}try (TestSetup.TelemetryClient t =\n`;
  body += `${indent}    TestSetup.telemetryClient(${javaLiteral(overrides)}, ${globalArg})) {\n`;
  body += `${inner}Quonfig client = t.client();\n`;
  const recvName = tiers.block ? 'scoped' : 'client';
  if (tiers.block) {
    body += `${inner}BoundQuonfig scoped = client.withContext(${ctxLiteral(tiers.block)});\n`;
  }
  const localArg = tiers.local ? ctxLiteral(tiers.local) : null;

  const evalKey = (recv: string, key: string, perCall: string | null): string => {
    const valueType = rctx.valueTypes.get(key);
    if (!valueType) {
      throw new Error(`telemetry key ${JSON.stringify(key)} is not a config in the fixture datadir`);
    }
    const yamlType = VALUE_TYPE_TO_YAML[valueType];
    if (!yamlType) throw new Error(`unknown valueType ${valueType} for ${key}`);
    const getter = getterFor(yamlType);
    const keyLit = javaStringLiteral(key);
    const call = perCall
      ? `${recv}.${getter.method}(${keyLit}, null, ${perCall})`
      : `${recv}.${getter.method}(${keyLit}, null)`;
    return `${inner}t.saw(${keyLit}, ${call});\n`;
  };

  if (aggregator === 'evaluation_summary') {
    const d = (data ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(d)) {
      if (k !== 'keys' && k !== 'keys_without_context') {
        throw new Error(`unknown evaluation_summary data field ${k}`);
      }
    }
    const keys = Array.isArray(d.keys) ? (d.keys as unknown[]) : [];
    const keysWithout = Array.isArray(d.keys_without_context)
      ? (d.keys_without_context as unknown[])
      : [];
    if (keys.length + keysWithout.length === 0) {
      throw new Error('evaluation_summary case evaluates no keys');
    }
    for (const k of keys) body += evalKey(recvName, String(k), localArg);
    for (const k of keysWithout) body += evalKey('client', String(k), null);
  } else {
    if (tiers.global || tiers.block || tiers.local) {
      throw new Error(`${aggregator} cases take their contexts from \`data\`, not contexts tiers`);
    }
    const records = Array.isArray(data) ? data : [data ?? {}];
    for (const rec of records) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        throw new Error(`${aggregator} data records must be context maps`);
      }
      body += evalKey('client', CONTEXT_PROBE_KEY, ctxLiteral(rec as ContextTypes));
    }
  }

  const want = javaLiteral(expectedData);
  if (want === 'null') {
    body += `${inner}assertNull(t.${projection}());\n`;
  } else {
    body += `${inner}assertEquals(\n`;
    body += `${inner}    ${want},\n`;
    body += `${inner}    t.${projection}());\n`;
  }
  body += `${indent}}\n`;
  return body;
}

// ---------------------------------------------------------------------------
// delivery_environment.yaml renderer (self-contained HttpServer)
// ---------------------------------------------------------------------------

/**
 * Render a delivery_environment.yaml case body. Cross-SDK DELIVERY-WIRE-SHAPE
 * gate (qfg-xpln): stands up an in-process com.sun.net.httpserver.HttpServer
 * returning the literal `envelope` JSON on /api/v2/configs (the shape
 * api-delivery emits in SDK-key mode), builds a real Quonfig in SDK-key mode
 * (NO environment pin unless client_overrides.environment is set), awaits init
 * (which installs the wire envelope), and asserts the resolved boolean.
 * Exercises the wire parse + meta.environment selection path the datadir tests
 * never touch. Modeled on the hand-written HttpDeliverySingularEnvironmentTest.
 */
function renderDeliveryBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envelope = kase.envelope;
  const indent = '    ';

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
  const expectedBool = expVal === true ? 'Boolean.TRUE' : 'Boolean.FALSE';
  const builderLines: string[] = [
    `.sdkKey(${javaStringLiteral(sdkKey)})`,
    `.apiUrls(java.util.List.of(base))`,
    `.streamUrls(java.util.List.of(base))`,
    `.telemetryUrl(base)`,
    `.fallbackPollEnabled(false)`,
    `.initTimeout(java.time.Duration.ofSeconds(5))`,
    `.disableTelemetry(true)`,
  ];
  if ('environment' in overrides) {
    builderLines.push(`.environment(${javaStringLiteral(String(overrides.environment))})`);
  }

  let body = '';
  body += `${indent}String envelope = ${javaStringLiteral(envelopeJson)};\n`;
  body += `${indent}HttpServer server = startDeliveryServer(envelope);\n`;
  body += `${indent}try {\n`;
  body += `${indent}  String base = "http://127.0.0.1:" + server.getAddress().getPort();\n`;
  body += `${indent}  Options o =\n`;
  body += `${indent}      Options.builder()\n`;
  for (const line of builderLines) {
    body += `${indent}          ${line}\n`;
  }
  body += `${indent}          .build();\n`;
  body += `${indent}  try (Quonfig q = new Quonfig(o)) {\n`;
  body += `${indent}    q.initFuture().get(5, java.util.concurrent.TimeUnit.SECONDS);\n`;
  body += `${indent}    Boolean v = q.getBool(${javaStringLiteral(key)}, Boolean.${expVal === true ? 'FALSE' : 'TRUE'});\n`;
  body += `${indent}    assertEquals(\n`;
  body += `${indent}        ${expectedBool},\n`;
  body += `${indent}        v,\n`;
  body += `${indent}        ${javaStringLiteral(`delivery-wire env override: expected ${expVal} for ${key}`)});\n`;
  body += `${indent}  }\n`;
  body += `${indent}} finally {\n`;
  body += `${indent}  server.stop(0);\n`;
  body += `${indent}}\n`;
  return body;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function renderDeliveryFile(suite: SuiteEntry, result: RenderResult): string {
  let out = '';
  out += `// AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=java\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;
  out += `package ${PACKAGE};\n`;
  out += `\n`;
  out += `import static org.junit.jupiter.api.Assertions.assertEquals;\n`;
  out += `\n`;
  out += `import com.quonfig.sdk.Options;\n`;
  out += `import com.quonfig.sdk.Quonfig;\n`;
  out += `import com.sun.net.httpserver.HttpExchange;\n`;
  out += `import com.sun.net.httpserver.HttpHandler;\n`;
  out += `import com.sun.net.httpserver.HttpServer;\n`;
  out += `import java.io.IOException;\n`;
  out += `import java.io.OutputStream;\n`;
  out += `import java.net.InetSocketAddress;\n`;
  out += `import java.nio.charset.StandardCharsets;\n`;
  out += `import java.util.ArrayList;\n`;
  out += `import java.util.List;\n`;
  out += `import org.junit.jupiter.api.AfterEach;\n`;
  out += `import org.junit.jupiter.api.DisplayName;\n`;
  out += `import org.junit.jupiter.api.Test;\n`;
  out += `\n`;
  out += `class ${suite.className} {\n`;
  out += `\n`;
  out += `  private final List<HttpServer> servers = new ArrayList<>();\n`;
  out += `\n`;
  out += `  @AfterEach\n`;
  out += `  void stopServers() {\n`;
  out += `    for (HttpServer s : servers) s.stop(0);\n`;
  out += `    servers.clear();\n`;
  out += `  }\n`;
  out += `\n`;
  out += `  // Stand up an in-process server returning the literal wire envelope on\n`;
  out += `  // /api/v2/configs (the shape api-delivery emits in SDK-key mode). The SSE\n`;
  out += `  // context stays open without frames so the initial HTTP install stands.\n`;
  out += `  private HttpServer startDeliveryServer(String envelope) throws IOException {\n`;
  out += `    HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);\n`;
  out += `    HttpHandler getHandler =\n`;
  out += `        (HttpExchange ex) -> {\n`;
  out += `          byte[] body = envelope.getBytes(StandardCharsets.UTF_8);\n`;
  out += `          ex.getResponseHeaders().add("Content-Type", "application/json");\n`;
  out += `          ex.getResponseHeaders().add("ETag", "\\"v1\\"");\n`;
  out += `          ex.sendResponseHeaders(200, body.length);\n`;
  out += `          try (OutputStream out = ex.getResponseBody()) {\n`;
  out += `            out.write(body);\n`;
  out += `          }\n`;
  out += `        };\n`;
  out += `    HttpHandler sseHandler =\n`;
  out += `        (HttpExchange ex) -> {\n`;
  out += `          ex.getResponseHeaders().add("Content-Type", "text/event-stream");\n`;
  out += `          ex.sendResponseHeaders(200, 0);\n`;
  out += `          try (OutputStream out = ex.getResponseBody()) {\n`;
  out += `            out.write(":ok\\n\\n".getBytes(StandardCharsets.UTF_8));\n`;
  out += `            out.flush();\n`;
  out += `            for (int i = 0; i < 100; i++) {\n`;
  out += `              try {\n`;
  out += `                Thread.sleep(50);\n`;
  out += `              } catch (InterruptedException e) {\n`;
  out += `                Thread.currentThread().interrupt();\n`;
  out += `                return;\n`;
  out += `              }\n`;
  out += `            }\n`;
  out += `          } catch (IOException ignored) {\n`;
  out += `            // expected when the client disconnects\n`;
  out += `          }\n`;
  out += `        };\n`;
  out += `    s.createContext("/api/v2/configs", getHandler);\n`;
  out += `    s.createContext("/api/v2/sse/config", sseHandler);\n`;
  out += `    s.start();\n`;
  out += `    servers.add(s);\n`;
  out += `    return s;\n`;
  out += `  }\n`;
  for (const r of result.rendered) {
    out += r.source;
  }
  out += `}\n`;
  return out;
}


function renderFile(suite: SuiteEntry, result: RenderResult): string {
  if (suite.yaml === 'delivery_environment.yaml') {
    return renderDeliveryFile(suite, result);
  }
  const src = result.rendered.map((r) => r.source).join('');

  let out = '';
  out += `// AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=java\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;
  out += `package ${PACKAGE};\n`;
  out += `\n`;
  // Import only what the rendered cases use (spotless / unused-import hygiene).
  for (const a of ['assertEquals', 'assertNotNull', 'assertNull', 'assertThrows']) {
    if (new RegExp(`\\b${a}\\(`).test(src)) {
      out += `import static org.junit.jupiter.api.Assertions.${a};\n`;
    }
  }
  out += `\n`;
  if (/\bBoundQuonfig\b/.test(src)) out += `import com.quonfig.sdk.BoundQuonfig;\n`;
  if (/\bQuonfig\b/.test(src)) out += `import com.quonfig.sdk.Quonfig;\n`;
  // Exception classes referenced by raise-cases. java.lang.* is auto-imported.
  const exceptions = Array.from(result.exceptions)
    .filter((fqcn) => !fqcn.startsWith('java.lang.'))
    .sort();
  for (const fqcn of exceptions) {
    out += `import ${fqcn};\n`;
  }
  if (/@Disabled\(/.test(src)) out += `import org.junit.jupiter.api.Disabled;\n`;
  out += `import org.junit.jupiter.api.DisplayName;\n`;
  out += `import org.junit.jupiter.api.Test;\n`;

  out += `\n`;
  out += `class ${suite.className} {\n`;
  out += src;
  out += `}\n`;
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface JavaRunResult {
  written: { path: string; cases: number }[];
}

/**
 * @param dataRoot integration-test-data/tests/eval (absolute)
 * @param outDir   sdk-java/core/src/test/java/com/quonfig/sdk/integration (absolute)
 */
export function runJavaTarget(dataRoot: string, outDir: string): JavaRunResult {
  mkdirSync(outDir, { recursive: true });
  const written: JavaRunResult['written'] = [];
  const rctx: RenderCtx = {
    valueTypes: loadValueTypes(resolve(dataRoot, '..', '..', 'data', 'integration-tests')),
  };
  const unsupportedSeen = new Set<string>();

  const outputs: { path: string; src: string; cases: number }[] = [];
  for (const suite of SUITES) {
    if (suite.className !== javaSuiteClassName(suite.yaml)) {
      throw new Error(
        `[java] class name mismatch for ${suite.yaml}: ` +
          `entry=${suite.className} derived=${javaSuiteClassName(suite.yaml)}`,
      );
    }
    const yamlPath = resolve(dataRoot, suite.yaml);
    const cases = loadYamlFile(yamlPath, suite.yaml);
    const result = renderCases(suite, cases, rctx, unsupportedSeen);
    outputs.push({
      path: resolve(outDir, suite.out),
      src: renderFile(suite, result),
      cases: result.rendered.length,
    });
  }

  const stale = Object.keys(UNSUPPORTED).filter((k) => !unsupportedSeen.has(k));
  if (stale.length > 0) {
    throw new GeneratorError(`UNSUPPORTED entries match no case: ${stale.join('; ')}`);
  }

  for (const o of outputs) {
    writeFileSync(o.path, o.src);
    written.push({ path: o.path, cases: o.cases });
  }
  return { written };
}

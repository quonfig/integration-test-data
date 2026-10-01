// Go target — generates *_generated_test.go files under
// sdk-go/internal/fixtures/, one per YAML suite.
//
// Every case drives the PUBLIC quonfig.Client exactly as a customer would
// (qfg-2agi.31): typed getters chosen by the YAML `type:`, FeatureIsOn for
// `function: enabled`, the (value, ok, err) triple as both the no-default and
// the get_or_raise form, context tiers fed through WithGlobalContext /
// WithContext / the per-call ctx (never pre-merged here), and telemetry
// asserted on the wire bytes the real client flushes on Close(). The
// hand-written helpers in sdk-go/internal/fixtures/*_helpers_test.go only
// build clients and decode payloads; they must never evaluate, resolve,
// coerce or aggregate on the SDK's behalf.
//
// Hard rules (set by project owner):
//
//   1. NO auto-skips, NO omissions, NO defensive shortcuts. Every YAML case
//      becomes a real, runnable Go test function against the public API.
//
//   2. Unmapped raise errors, unsupported shapes and missing input keys FAIL
//      the generator (not the test). Better to stop here with a clear
//      pointer than to silently emit broken code.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import {
  goSuiteName,
  goTestFunctionName,
  uniqueGoSuffix,
} from '../shared/case-id.js';
import { repeatSpec, repeatValueType } from '../shared/repeat.js';
import type { ContextTypes, NormalizedCase, YamlCase } from '../types.js';

interface SuiteEntry {
  yaml: string;
  out: string;
  // packagePrefix is currently always "fixtures"; here for symmetry
  // with the Ruby `className` field.
  suite: string;
}

const SUITES: SuiteEntry[] = [
  { yaml: 'get.yaml', out: 'get_generated_test.go', suite: 'Get' },
  { yaml: 'enabled.yaml', out: 'enabled_generated_test.go', suite: 'Enabled' },
  { yaml: 'get_or_raise.yaml', out: 'get_or_raise_generated_test.go', suite: 'GetOrRaise' },
  { yaml: 'get_feature_flag.yaml', out: 'get_feature_flag_generated_test.go', suite: 'GetFeatureFlag' },
  { yaml: 'get_weighted_values.yaml', out: 'get_weighted_values_generated_test.go', suite: 'GetWeightedValues' },
  { yaml: 'context_precedence.yaml', out: 'context_precedence_generated_test.go', suite: 'ContextPrecedence' },
  { yaml: 'enabled_with_contexts.yaml', out: 'enabled_with_contexts_generated_test.go', suite: 'EnabledWithContexts' },
  { yaml: 'datadir_environment.yaml', out: 'datadir_environment_generated_test.go', suite: 'DatadirEnvironment' },
  { yaml: 'datadir_value_type.yaml', out: 'datadir_value_type_generated_test.go', suite: 'DatadirValueType' },
  { yaml: 'delivery_environment.yaml', out: 'delivery_environment_generated_test.go', suite: 'DeliveryEnvironment' },
  { yaml: 'post.yaml', out: 'post_generated_test.go', suite: 'Post' },
  { yaml: 'telemetry.yaml', out: 'telemetry_generated_test.go', suite: 'Telemetry' },
  { yaml: 'dev_overrides.yaml', out: 'dev_overrides_generated_test.go', suite: 'DevOverrides' },
];

const GENERATOR_PATH = 'integration-test-data/generators/src/targets/go.ts';

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
}

// ---------------------------------------------------------------------------
// Go literal rendering
// ---------------------------------------------------------------------------

/** Quote a string the way Go's strconv.Quote does for the safe ASCII subset. */
function goStringLiteral(s: string): string {
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
      out += '\\x' + code.toString(16).padStart(2, '0').toUpperCase();
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

/** Render a value as a Go expression of type `interface{}`. */
function goLiteralValue(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toString();
    return value.toString();
  }
  if (typeof value === 'string') return goStringLiteral(value);
  if (Array.isArray(value)) {
    return '[]interface{}{' + value.map(goLiteralValue).join(', ') + '}';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${goStringLiteral(k)}: ${goLiteralValue(v)}`,
    );
    return 'map[string]interface{}{' + entries.join(', ') + '}';
  }
  return goStringLiteral(String(value));
}

/**
 * Render a `[]string` literal — used by {@link assertStringListValue} which
 * takes a typed `[]string` rather than `[]interface{}`.
 */
function goStringListLiteral(values: unknown[]): string {
  const parts = values.map((v) => {
    if (typeof v !== 'string') {
      throw new Error(`expected string list element, got ${typeof v}: ${JSON.stringify(v)}`);
    }
    return goStringLiteral(v);
  });
  return '[]string{' + parts.join(', ') + '}';
}

/**
 * Render a context-tier as a Go literal of type
 * `map[string]map[string]interface{}` (or the bare keyword `nil` if empty).
 *
 * A merged-context structure looks like:
 *   { user: { key: "michael" }, "": { domain: "prefab.cloud" } }
 */
function goContextLiteral(ctx: ContextTypes): string {
  const keys = Object.keys(ctx);
  if (keys.length === 0) return 'nil';
  const lines: string[] = [];
  for (const [type, props] of Object.entries(ctx)) {
    const entries = Object.entries(props as Record<string, unknown>).map(
      ([k, v]) => `${goStringLiteral(k)}: ${goLiteralValue(v)}`,
    );
    lines.push(
      `${goStringLiteral(type)}: {${entries.join(', ')}}`,
    );
  }
  return 'map[string]map[string]interface{}{' + lines.join(', ') + '}';
}

// ---------------------------------------------------------------------------
// Per-suite rendering
// ---------------------------------------------------------------------------

interface RenderedCase {
  source: string;
}

interface RenderResult {
  rendered: RenderedCase[];
  /**
   * Set of "feature tags" the renderer used — used to decide which Go
   * imports to emit on the generated file (e.g. `quonfig`, `assert`,
   * `require`, `eval`, `telemetry`).
   */
  features: Set<string>;
}

function renderCases(suite: SuiteEntry, cases: NormalizedCase[]): RenderResult {
  const rendered: RenderedCase[] = [];
  const seen = new Map<string, number>();
  const features = new Set<string>();

  for (const nc of cases) {
    const kase = nc.raw;
    const rawName = (kase.name ?? '').toString();
    const baseName = goTestFunctionName(rawName);
    const fnSuffix = uniqueGoSuffix(seen, baseName);

    let body: string;
    try {
      body = renderBody(suite, kase, features);
    } catch (e) {
      throw new GeneratorError(
        `[${suite.yaml}] case "${rawName}": ${(e as Error).message}`,
      );
    }

    const block =
      `\n` +
      `// ${rawName}\n` +
      `func Test${suite.suite}_${fnSuffix}(t *testing.T) {\n` +
      body +
      `}\n`;
    rendered.push({ source: block });
  }

  return { rendered, features };
}

/** Render one context tier as a `contextSet(...)` call (a `*quonfig.ContextSet`). */
function goContextSetExpr(ctx: ContextTypes): string {
  return `contextSet(${goContextLiteral(ctx)})`;
}

function nonEmptyTier(ctx: unknown): ContextTypes | null {
  if (!ctx || typeof ctx !== 'object') return null;
  if (Object.keys(ctx as object).length === 0) return null;
  return ctx as ContextTypes;
}

interface Tiers {
  global: ContextTypes | null;
  block: ContextTypes | null;
  local: ContextTypes | null;
}

function caseTiers(kase: YamlCase): Tiers {
  const c = kase.contexts ?? {};
  return {
    global: nonEmptyTier(c.global),
    block: nonEmptyTier(c.block),
    local: nonEmptyTier(c.local),
  };
}

/**
 * Render a public getter call on client `c` with the case's context tiers
 * fed through the SDK's own APIs (never pre-merged here):
 *   global -> quonfig.WithGlobalContext at construction (see clientSetup)
 *   block  -> c.WithContext(block)          (ContextBoundClient)
 *   local  -> the per-call ctx argument, or .WithContext(local) on a bound client
 */
function getterCallExpr(method: string, keyLit: string, tiers: Tiers): string {
  if (tiers.block) {
    let recv = `c.WithContext(${goContextSetExpr(tiers.block)})`;
    if (tiers.local) recv += `.WithContext(${goContextSetExpr(tiers.local)})`;
    return `${recv}.${method}(${keyLit})`;
  }
  const local = tiers.local ? goContextSetExpr(tiers.local) : 'nil';
  return `c.${method}(${keyLit}, ${local})`;
}

/**
 * The `c := ...` line: the shared datadir client, a fresh one carrying the
 * global tier via quonfig.WithGlobalContext, or an init-timeout client for
 * the client-construction overrides.
 */
function clientSetup(kase: YamlCase, tiers: Tiers): string {
  const overrides = kase.client_overrides ?? {};
  if (hasClientConstructionOverridesGo(overrides)) {
    if (tiers.global) {
      throw new Error('global context with init-timeout client overrides is unsupported');
    }
    const timeoutSec =
      typeof overrides.initialization_timeout_sec === 'number'
        ? overrides.initialization_timeout_sec
        : 0.01;
    const apiURL = typeof overrides.prefab_api_url === 'string' ? overrides.prefab_api_url : '';
    if (apiURL.length === 0) {
      throw new Error('init-timeout case needs client_overrides.prefab_api_url');
    }
    const onInit =
      typeof overrides.on_init_failure === 'string'
        ? overrides.on_init_failure.replace(/^:/, '')
        : 'raise';
    return `\tc := newInitTimeoutClient(t, ${formatDouble(timeoutSec)}, ${goStringLiteral(apiURL)}, ${goStringLiteral(onInit)})\n`;
  }
  for (const k of Object.keys(overrides)) {
    // on_no_default only selects which YAML expectation applies (absent
    // value vs raise); Go's (value, ok, err) getters carry both.
    if (k !== 'on_no_default') {
      throw new Error(`unsupported client_override for an eval case: ${k}`);
    }
  }
  if (tiers.global) {
    return `\tc := newPublicClient(t, quonfig.WithGlobalContext(${goContextSetExpr(tiers.global)}))\n`;
  }
  return `\tc := mustPublicClient(t)\n`;
}

function envVarLines(kase: YamlCase): string {
  const envVars = kase.env_vars;
  if (!envVars || typeof envVars !== 'object') return '';
  let out = '';
  for (const [k, v] of Object.entries(envVars)) {
    const sval = v === null || v === undefined ? '' : String(v);
    out += `\tt.Setenv(${goStringLiteral(k)}, ${goStringLiteral(sval)})\n`;
  }
  return out;
}

interface GoGetter {
  method: string;
  /** Render the expected value as a Go expression of the getter's type. */
  lit: (v: unknown) => string;
  /** JSON values compare through assertJSONValue, not assert.Equal. */
  json?: boolean;
}

function intLit(v: unknown): string {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`expected an integer, got ${JSON.stringify(v)}`);
  }
  return `int64(${v})`;
}

function millisLit(v: unknown): string {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`duration milliseconds must be an integer, got ${JSON.stringify(v)}`);
  }
  return `time.Duration(${v}) * time.Millisecond`;
}

/** Pick the public typed getter for the YAML `type:` (or infer it from the value). */
function goGetterFor(yamlType: string, sample: unknown): GoGetter {
  switch (yamlType) {
    case 'STRING':
    case 'LOG_LEVEL':
      return {
        method: 'GetStringValue',
        lit: (v) => {
          if (typeof v !== 'string') throw new Error(`STRING value is ${typeof v}`);
          return goStringLiteral(v);
        },
      };
    case 'INT':
      return { method: 'GetIntValue', lit: intLit };
    case 'DOUBLE':
      return {
        method: 'GetFloatValue',
        lit: (v) => {
          if (typeof v !== 'number') throw new Error(`DOUBLE value is ${typeof v}`);
          return formatDouble(v);
        },
      };
    case 'BOOLEAN':
      return {
        method: 'GetBoolValue',
        lit: (v) => {
          if (typeof v !== 'boolean') throw new Error(`BOOLEAN value is ${typeof v}`);
          return String(v);
        },
      };
    case 'STRING_LIST':
      return {
        method: 'GetStringSliceValue',
        lit: (v) => {
          if (!Array.isArray(v)) throw new Error('STRING_LIST value is not a list');
          return goStringListLiteral(v);
        },
      };
    case 'JSON':
      return { method: 'GetJSONValue', lit: goLiteralValue, json: true };
    case 'DURATION':
      return { method: 'GetDurationValue', lit: millisLit };
    case '':
      if (typeof sample === 'string') return goGetterFor('STRING', sample);
      if (typeof sample === 'boolean') return goGetterFor('BOOLEAN', sample);
      if (typeof sample === 'number' && Number.isInteger(sample)) return goGetterFor('INT', sample);
      if (typeof sample === 'number') return goGetterFor('DOUBLE', sample);
      throw new Error(`case has no type and value ${JSON.stringify(sample)}; can't pick a getter`);
    default:
      throw new Error(`unsupported YAML type: ${yamlType}`);
  }
}

/**
 * YAML error key -> exported sdk-go sentinel. Target-local on purpose: the
 * shared GO_ERRORS map in src/shared/error-mapping.ts predates the
 * public-API harness and lacks most of these.
 */
const GO_PUBLIC_ERRORS: Record<string, string> = {
  missing_default: 'quonfig.ErrNotFound',
  missing_env_var: 'quonfig.ErrMissingEnvVar',
  unable_to_coerce_env_var: 'quonfig.ErrUnableToCoerce',
  unable_to_decrypt: 'quonfig.ErrUnableToDecrypt',
  initialization_timeout: 'quonfig.ErrInitializationTimeout',
};

/**
 * Render a single test function body (everything between the opening `{`
 * and closing `}`). Returns text with a trailing newline.
 *
 * Every branch drives the PUBLIC quonfig.Client (qfg-2agi.31):
 *   - datadir_environment / datadir_value_type / delivery_environment:
 *     their own quonfig.NewClient(...) construction cases
 *   - post.yaml / telemetry.yaml: a real client with telemetry pointed at a
 *     local recorder, drained by Close()
 *   - everything else: typed getter / FeatureIsOn on a datadir client, with
 *     the YAML's `type:` and `function:` honoured and the context tiers fed
 *     through WithGlobalContext / WithContext / the ctx argument.
 */
function renderBody(
  suite: SuiteEntry,
  kase: YamlCase,
  features: Set<string>,
): string {
  if (suite.yaml === 'datadir_environment.yaml') {
    features.add('quonfig');
    features.add('require');
    features.add('assert');
    return renderDatadirBody(kase);
  }

  if (suite.yaml === 'datadir_value_type.yaml') {
    features.add('quonfig');
    features.add('require');
    features.add('assert');
    return renderDatadirValueTypeBody(kase, features);
  }

  if (suite.yaml === 'delivery_environment.yaml') {
    features.add('quonfig');
    features.add('require');
    features.add('assert');
    features.add('http');
    features.add('httptest');
    features.add('time');
    return renderDeliveryBody(kase);
  }

  // raw_value_type is a datadir-only field — see datadir_value_type.yaml. A
  // server-mode case carrying it would silently lose the raw-Value assertion,
  // so fail the generator loudly instead.
  if (
    kase.expected &&
    Object.prototype.hasOwnProperty.call(kase.expected, 'raw_value_type')
  ) {
    throw new Error(
      `expected.raw_value_type is only valid in datadir_value_type.yaml, not ${suite.yaml}`,
    );
  }

  if (suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml') {
    return renderTelemetryBody(kase, features);
  }

  return renderEvalBody(kase, features);
}

function renderEvalBody(kase: YamlCase, features: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const fn = (kase.function ?? 'get').toString();
  const yamlType = (kase.type ?? '').toString().toUpperCase();
  const tiers = caseTiers(kase);

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag');
  }
  const keyLit = goStringLiteral(key);

  if (fn !== 'get' && fn !== 'get_or_raise' && fn !== 'enabled') {
    throw new Error(`unsupported function: ${fn}`);
  }

  features.add('assert');
  if (tiers.global) features.add('quonfig');

  let body = '';
  body += envVarLines(kase);
  body += clientSetup(kase, tiers);

  // repeat + values_seen (qfg-t9wo): evaluate N times through the public
  // getter and assert the SET of values seen.
  const rspec = repeatSpec(kase);
  if (rspec) {
    if (fn === 'enabled') throw new Error('repeat is not supported with function: enabled');
    const vt = repeatValueType(kase, rspec);
    const getter = goGetterFor(vt === 'INT' ? 'INT' : 'STRING', rspec.valuesSeen[0]);
    const goType = vt === 'INT' ? 'int64' : 'string';
    features.add('require');
    body += `\tseen := map[${goType}]bool{}\n`;
    body += `\tfor i := 0; i < ${rspec.repeat}; i++ {\n`;
    body += `\t\tgot, ok, err := ${getterCallExpr(getter.method, keyLit, tiers)}\n`;
    body += `\t\trequire.NoError(t, err)\n`;
    body += `\t\trequire.True(t, ok, "evaluation %d of %q found no value", i, ${keyLit})\n`;
    body += `\t\tseen[got] = true\n`;
    body += `\t}\n`;
    body += `\tassert.Equal(t, map[${goType}]bool{${rspec.valuesSeen
      .map((v) => `${getter.lit(v)}: true`)
      .join(', ')}}, seen, "values seen over ${rspec.repeat} evaluations")\n`;
    return body;
  }

  // function: enabled -> FeatureIsOn (absent / non-boolean -> false).
  if (fn === 'enabled') {
    if (expected.status === 'raise') throw new Error('enabled cannot raise');
    if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
      throw new Error('enabled case has no expected.value');
    }
    const want = expected.value === true;
    if (expected.value !== null && typeof expected.value !== 'boolean') {
      throw new Error(`enabled expected.value must be a boolean, got ${JSON.stringify(expected.value)}`);
    }
    body += `\ton, _ := ${getterCallExpr('FeatureIsOn', keyLit, tiers)}\n`;
    body += `\tassert.Equal(t, ${want}, on, "FeatureIsOn(%q)", ${keyLit})\n`;
    return body;
  }

  // Raise: the (value, ok, err) form IS Go's get_or_raise — the error is
  // the raise, compared by sentinel with errors.Is.
  if (expected.status === 'raise') {
    const errKey = (expected.error ?? '').toString();
    const sentinel = GO_PUBLIC_ERRORS[errKey];
    if (!sentinel) {
      throw new Error(
        `no Go error mapping for expected.error="${errKey}"; add it to GO_PUBLIC_ERRORS in src/targets/go.ts`,
      );
    }
    const getter = goGetterFor(yamlType === '' ? 'STRING' : yamlType, undefined);
    features.add('quonfig');
    const onInit = (kase.client_overrides ?? {}).on_init_failure;
    const zeroValuePolicy =
      typeof onInit === 'string' && onInit.replace(/^:/, '') === 'return';
    body += `\t_, ok, err := ${getterCallExpr(getter.method, keyLit, tiers)}\n`;
    body += `\tassert.False(t, ok, "%q must have no value", ${keyLit})\n`;
    if (zeroValuePolicy) {
      // on_init_failure :return maps to quonfig.ReturnZeroValue, documented
      // as "getters return zero values" — no error. The init timeout must
      // not surface; "no value" is ok=false.
      if (errKey !== 'missing_default') {
        throw new Error(`on_init_failure :return with expected.error=${errKey} is unsupported`);
      }
      body += `\tassert.NotErrorIs(t, err, quonfig.ErrInitializationTimeout, "ReturnZeroValue must not surface the init timeout")\n`;
    } else {
      features.add('require');
      body += `\trequire.ErrorIs(t, err, ${sentinel})\n`;
    }
    return body;
  }

  // Value expectations.
  let expectedValue: unknown;
  let isMillis = false;
  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    expectedValue = expected.millis;
    isMillis = true;
    if (yamlType !== 'DURATION') throw new Error('expected.millis on a non-DURATION case');
  } else if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    expectedValue = expected.value;
    if (yamlType === 'DURATION' && expectedValue !== null && expectedValue !== undefined) {
      throw new Error('DURATION type with a non-null expected.value (use expected.millis)');
    }
  } else {
    throw new Error('case has no expected.value or expected.millis');
  }

  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  const def = (input as { default?: unknown }).default;
  const getter = goGetterFor(yamlType, hasDefault ? def : expectedValue);
  if (yamlType === 'DURATION' || isMillis) features.add('time');
  const call = getterCallExpr(getter.method, keyLit, tiers);

  // No value expected (on_no_default / absent): Go's absent value is the
  // zero value with ok=false.
  if (expectedValue === null || expectedValue === undefined) {
    if (hasDefault) throw new Error('a default with a null expected value is contradictory');
    body += `\tgot, ok, _ := ${call}\n`;
    body += `\tassert.False(t, ok, "%q must have no value", ${keyLit})\n`;
    body += `\tassert.Zero(t, got)\n`;
    return body;
  }

  const wantLit = getter.lit(expectedValue);
  if (hasDefault) {
    // Go has no default-argument getter; a customer applies the default
    // when the getter reports ok=false. A getter that reports ok=true with
    // a wrong value bypasses the default and fails here.
    if (getter.json) throw new Error('JSON with input.default is unsupported');
    body += `\tgot, ok, _ := ${call}\n`;
    body += `\tif !ok {\n`;
    body += `\t\tgot = ${getter.lit(def)}\n`;
    body += `\t}\n`;
    body += `\twant := ${wantLit}\n`;
    body += `\tassert.Equal(t, want, got)\n`;
    return body;
  }

  features.add('require');
  body += `\tgot, ok, err := ${call}\n`;
  body += `\trequire.NoError(t, err)\n`;
  body += `\trequire.True(t, ok, "%q found no value", ${keyLit})\n`;
  // Bind want at statement level so gofmt keeps the emitted spacing.
  body += `\twant := ${wantLit}\n`;
  if (getter.json) {
    body += `\tassertJSONValue(t, want, got)\n`;
  } else {
    body += `\tassert.Equal(t, want, got)\n`;
  }
  return body;
}

/**
 * Render a datadir_environment.yaml case body. Uses
 * `quonfig.NewClient(WithDataDir(testDataDir), WithEnvironment(...))` and
 * either calls Get or asserts construction returns an error.
 */
function renderDatadirBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars;
  const func = (kase.function ?? 'get').toString();
  const indent = '\t';

  let body = '';
  if (envVars && typeof envVars === 'object') {
    for (const [k, v] of Object.entries(envVars)) {
      const sval = v === null || v === undefined ? '' : String(v);
      body += `${indent}t.Setenv(${goStringLiteral(k)}, ${goStringLiteral(sval)})\n`;
    }
  }

  const opts: string[] = [];
  if ('datadir' in overrides) {
    opts.push('quonfig.WithDataDir(dataDir)');
  }
  if ('environment' in overrides) {
    opts.push(`quonfig.WithEnvironment(${goStringLiteral(String(overrides.environment))})`);
  }
  const optsRendered = opts.length > 0 ? opts.join(', ') : '';

  if (func === 'init' && expected.status === 'raise') {
    // Init-failure path — assert NewClient returns an error mentioning
    // the relevant token (env var name or invalid environment name).
    const errKey = (expected.error ?? '').toString();
    if (errKey.length === 0) {
      throw new Error('init raise case missing expected.error');
    }
    body += `${indent}_, err := quonfig.NewClient(${optsRendered})\n`;
    body += `${indent}require.Error(t, err)\n`;
    if (errKey === 'missing_environment') {
      body += `${indent}assert.Contains(t, err.Error(), "environment")\n`;
    } else if (errKey === 'invalid_environment') {
      const envName = String(overrides.environment ?? '');
      body += `${indent}assert.Contains(t, err.Error(), ${goStringLiteral(envName)})\n`;
    } else {
      const errClass = GO_PUBLIC_ERRORS[errKey];
      if (!errClass) {
        throw new Error(`no Go error mapping for init expected.error="${errKey}"`);
      }
      body += `${indent}assert.ErrorIs(t, err, ${errClass})\n`;
    }
    return body;
  }

  // Happy path — construct, call Get, verify value.
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('datadir get-case has no input.key/flag');
  }
  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('datadir get-case has no expected.value');
  }

  body += `${indent}client, err := quonfig.NewClient(${optsRendered})\n`;
  body += `${indent}require.NoError(t, err)\n`;
  body += `${indent}defer client.Close()\n`;
  body += `\n`;
  body += `${indent}val, ok, err := client.GetStringValue(${goStringLiteral(key)}, nil)\n`;
  body += `${indent}require.NoError(t, err)\n`;
  body += `${indent}require.True(t, ok)\n`;
  const expVal = expected.value;
  if (typeof expVal !== 'string') {
    throw new Error('datadir get-case currently only handles string values');
  }
  body += `${indent}assert.Equal(t, ${goStringLiteral(expVal)}, val)\n`;
  return body;
}

/**
 * Render a datadir_value_type.yaml case body. Constructs a real datadir-mode
 * client, asserts the public typed getter's coerced value, and — when
 * `expected.raw_value_type === "number"` — ALSO asserts the resolved-but-not-
 * coerced `*Value` returned by `client.EvaluateKey(key, nil)` carries a real
 * numeric `.Value` (float64 / int64 / json.Number), not a string. sdk-go
 * coerces int/double at load (`Value.UnmarshalJSON`), so this is green
 * immediately and doubles as confirmation the reference loader is correct.
 */
function renderDatadirValueTypeBody(kase: YamlCase, features: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const indent = '\t';

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

  const opts: string[] = [];
  if ('datadir' in overrides) {
    opts.push('quonfig.WithDataDir(dataDir)');
  }
  if ('environment' in overrides) {
    opts.push(`quonfig.WithEnvironment(${goStringLiteral(String(overrides.environment))})`);
  }
  const optsRendered = opts.join(', ');

  const keyLit = goStringLiteral(key);
  const yamlType = (kase.type ?? '').toString().toUpperCase();
  const expVal = expected.value;

  let body = '';
  body += `${indent}client, err := quonfig.NewClient(${optsRendered})\n`;
  body += `${indent}require.NoError(t, err)\n`;
  body += `${indent}defer client.Close()\n`;
  body += `\n`;

  // Public typed getter — the coerced value.
  if (yamlType === 'INT') {
    if (typeof expVal !== 'number' || !Number.isInteger(expVal)) {
      throw new Error(`INT type but expected.value is not an integer: ${expVal}`);
    }
    body += `${indent}val, ok, err := client.GetIntValue(${keyLit}, nil)\n`;
    body += `${indent}require.NoError(t, err)\n`;
    body += `${indent}require.True(t, ok)\n`;
    body += `${indent}assert.Equal(t, int64(${expVal}), val)\n`;
  } else if (yamlType === 'DOUBLE') {
    if (typeof expVal !== 'number') {
      throw new Error(`DOUBLE type but expected.value is not a number: ${expVal}`);
    }
    body += `${indent}val, ok, err := client.GetFloatValue(${keyLit}, nil)\n`;
    body += `${indent}require.NoError(t, err)\n`;
    body += `${indent}require.True(t, ok)\n`;
    body += `${indent}assert.Equal(t, ${formatDouble(expVal)}, val)\n`;
  } else {
    throw new Error(`datadir_value_type case has unsupported type: ${yamlType}`);
  }

  if (rawType === 'number') {
    // Inspect the resolved-but-not-coerced *Value, before any typed-getter
    // coercion. A datadir loader that left int/double as on-disk strings
    // surfaces here as a string-typed raw.Value.
    features.add('json');
    body += `\n`;
    body += `${indent}raw, _, found, err := client.EvaluateKey(${keyLit}, nil)\n`;
    body += `${indent}require.NoError(t, err)\n`;
    body += `${indent}require.True(t, found)\n`;
    body += `${indent}require.NotNil(t, raw)\n`;
    body += `${indent}switch raw.Value.(type) {\n`;
    body += `${indent}case float64, float32, int, int64, int32, json.Number:\n`;
    body += `${indent}\t// ok — datadir loader coerced int/double to a real number\n`;
    body += `${indent}default:\n`;
    body += `${indent}\tt.Fatalf("datadir loader must coerce %s to a number, got %T (%v)", ${keyLit}, raw.Value, raw.Value)\n`;
    body += `${indent}}\n`;
  }
  return body;
}

/**
 * Render a delivery_environment.yaml case body. This is the cross-SDK
 * DELIVERY-WIRE-SHAPE regression gate (qfg-xpln): it stands up a real
 * httptest server returning the literal `envelope` JSON from the YAML on
 * `/api/v2/configs`, builds a public SDK-key-mode client against it (NO
 * environment pin unless `client_overrides.environment` is present), and
 * asserts the resolved boolean. The whole point is to exercise the wire
 * parse + meta.environment env-selection path the datadir tests never touch.
 */
function renderDeliveryBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envelope = kase.envelope;
  const indent = '\t';

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
    `quonfig.WithSdkKey(${goStringLiteral(sdkKey)})`,
    `quonfig.WithAPIURLs([]string{server.URL})`,
    `quonfig.WithSSE(false)`,
    `quonfig.WithFallbackPoll(false, 0)`,
    `quonfig.WithAllTelemetryDisabled()`,
    `quonfig.WithInitTimeout(5*time.Second)`,
  ];
  if ('environment' in overrides) {
    // Explicit pin must win over meta.environment.
    opts.push(`quonfig.WithEnvironment(${goStringLiteral(String(overrides.environment))})`);
  }

  let body = '';
  body += `${indent}const envelopeJSON = ${goStringLiteral(envelopeJson)}\n`;
  body += `${indent}server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n`;
  body += `${indent}\tif r.URL.Path != "/api/v2/configs" {\n`;
  body += `${indent}\t\tw.WriteHeader(http.StatusNotFound)\n`;
  body += `${indent}\t\treturn\n`;
  body += `${indent}\t}\n`;
  body += `${indent}\tw.Header().Set("Content-Type", "application/json")\n`;
  body += `${indent}\tw.Header().Set("ETag", "\\"v1\\"")\n`;
  body += `${indent}\t_, _ = w.Write([]byte(envelopeJSON))\n`;
  body += `${indent}}))\n`;
  body += `${indent}defer server.Close()\n`;
  body += `\n`;
  body += `${indent}client, err := quonfig.NewClient(\n`;
  for (const o of opts) {
    body += `${indent}\t${o},\n`;
  }
  body += `${indent})\n`;
  body += `${indent}require.NoError(t, err)\n`;
  body += `${indent}defer client.Close()\n`;
  body += `\n`;
  body += `${indent}val, ok, err := client.GetBoolValue(${goStringLiteral(key)}, nil)\n`;
  body += `${indent}require.NoError(t, err)\n`;
  body += `${indent}require.True(t, ok, "expected config %q to be present from wire envelope", ${goStringLiteral(key)})\n`;
  body += `${indent}assert.Equal(t, ${expVal === true}, val, "delivery-wire env override: expected %v for %q", ${expVal === true}, ${goStringLiteral(key)})\n`;
  return body;
}

/** value_type in a telemetry expected row -> the public getter a customer would call. */
const TELEMETRY_GETTERS: Record<string, string> = {
  string: 'GetStringValue',
  log_level: 'GetStringValue',
  int: 'GetIntValue',
  double: 'GetFloatValue',
  bool: 'GetBoolValue',
  string_list: 'GetStringSliceValue',
  json: 'GetJSONValue',
  duration: 'GetDurationValue',
};

/**
 * Render post.yaml / telemetry.yaml case bodies: a real client whose
 * telemetry URL is a local recorder, driven through public getters, then
 * drained (Close() runs the SDK's shutdown flush) and asserted on the wire
 * bytes:
 *   tel := startTelemetryClient(t, overrides[, quonfig.WithGlobalContext(...)])
 *   c := tel.Client
 *   _, _, _ = c.WithContext(block).GetIntValue("key")   // evaluation_summary
 *   _, _, _ = c.GetStringValue(probe, contextSet(rec))  // context records
 *   assertTelemetryPost(t, tel, kind, expected, endpoint)
 */
function renderTelemetryBody(kase: YamlCase, features: Set<string>): string {
  const aggregator = (kase.aggregator ?? '').toString();
  if (aggregator.length === 0) throw new Error('post/telemetry case missing aggregator');
  const endpoint = (kase.endpoint ?? '').toString();
  if (endpoint.length === 0) throw new Error('post/telemetry case missing endpoint');

  const data = Object.prototype.hasOwnProperty.call(kase, 'data') ? kase.data : null;
  const expectedData = Object.prototype.hasOwnProperty.call(kase, 'expected_data')
    ? kase.expected_data
    : null;
  const overrides = kase.client_overrides ?? {};
  const tiers = caseTiers(kase);

  let body = '';
  const extra = tiers.global ? `, quonfig.WithGlobalContext(${goContextSetExpr(tiers.global)})` : '';
  if (tiers.global) features.add('quonfig');
  body += `\ttel := startTelemetryClient(t, ${goLiteralValue(overrides)}${extra})\n`;
  body += `\tc := tel.Client\n`;

  if (aggregator === 'evaluation_summary') {
    const d = (data ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(expectedData) ? (expectedData as Array<Record<string, unknown>>) : [];
    const getterFor = (key: string): string => {
      const row = rows.find((r) => r && r.key === key);
      const vt = row && typeof row.value_type === 'string' ? row.value_type : 'string';
      const m = TELEMETRY_GETTERS[vt];
      if (!m) throw new Error(`no getter for telemetry value_type ${vt}`);
      return m;
    };
    const keysOf = (v: unknown, field: string): string[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.some((k) => typeof k !== 'string')) {
        throw new Error(`data.${field} must be a list of keys`);
      }
      return v as string[];
    };
    for (const k of Object.keys(d)) {
      if (k !== 'keys' && k !== 'keys_without_context') {
        throw new Error(`unsupported evaluation_summary data field: ${k}`);
      }
    }
    for (const key of keysOf(d.keys, 'keys')) {
      body += `\t_, _, _ = ${getterCallExpr(getterFor(key), goStringLiteral(key), tiers)}\n`;
    }
    for (const key of keysOf(d.keys_without_context, 'keys_without_context')) {
      body += `\t_, _, _ = c.${getterFor(key)}(${goStringLiteral(key)}, nil)\n`;
    }
  } else if (aggregator === 'context_shape' || aggregator === 'example_contexts') {
    if (tiers.global || tiers.block || tiers.local) {
      throw new Error(`${aggregator} cases take their contexts from data, not contexts`);
    }
    const records = data === null ? [] : Array.isArray(data) ? data : [data];
    for (const rec of records) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        throw new Error(`${aggregator} data records must be context maps`);
      }
      body += `\t_, _, _ = c.GetStringValue(telemetryContextProbeKey, ${goContextSetExpr(rec as ContextTypes)})\n`;
    }
  } else {
    throw new Error(`unknown aggregator: ${aggregator}`);
  }

  body += `\tassertTelemetryPost(t, tel, ${goStringLiteral(aggregator)}, ${goLiteralValue(expectedData)}, ${goStringLiteral(endpoint)})\n`;
  return body;
}

function hasClientConstructionOverridesGo(overrides: unknown): boolean {
  if (!overrides || typeof overrides !== 'object') return false;
  const o = overrides as Record<string, unknown>;
  return (
    'initialization_timeout_sec' in o ||
    'prefab_api_url' in o ||
    'on_init_failure' in o
  );
}

function formatDouble(n: number): string {
  if (Number.isInteger(n)) return n.toFixed(1); // 0 → 0.0 so it parses as float
  return n.toString();
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function renderFile(suite: SuiteEntry, rendered: RenderedCase[], features: Set<string>): string {
  const imports: string[] = ['"testing"'];
  if (features.has('errors')) {
    imports.push('"errors"');
  }
  if (features.has('json')) {
    imports.push('"encoding/json"');
  }
  if (features.has('http')) {
    imports.push('"net/http"');
  }
  if (features.has('httptest')) {
    imports.push('"net/http/httptest"');
  }
  if (features.has('time')) {
    imports.push('"time"');
  }
  // gofmt orders the stdlib block lexically (by the quoted path). Sort so the
  // emitted file is gofmt-clean without a post-pass.
  imports.sort((a, b) => a.localeCompare(b));
  // Third-party / project imports go in a separate block per gofmt style.
  const projectImports: string[] = [];
  if (features.has('quonfig')) {
    projectImports.push('quonfig "github.com/quonfig/sdk-go"');
  }
  if (features.has('assert')) {
    projectImports.push('"github.com/stretchr/testify/assert"');
  }
  if (features.has('require')) {
    projectImports.push('"github.com/stretchr/testify/require"');
  }

  let out = '';
  out += `// Code generated from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=go\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;
  out += `package fixtures\n`;
  out += `\n`;
  out += `import (\n`;
  for (const imp of imports) {
    out += `\t${imp}\n`;
  }
  if (projectImports.length > 0) {
    out += `\n`;
    for (const imp of projectImports) {
      out += `\t${imp}\n`;
    }
  }
  out += `)\n`;

  for (const r of rendered) {
    out += r.source;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GoRunResult {
  written: { path: string; cases: number }[];
}

/**
 * @param dataRoot integration-test-data/tests/eval (absolute)
 * @param outDir   sdk-go/internal/fixtures         (absolute)
 */
export function runGoTarget(dataRoot: string, outDir: string): GoRunResult {
  mkdirSync(outDir, { recursive: true });
  const written: GoRunResult['written'] = [];

  for (const suite of SUITES) {
    if (suite.suite !== goSuiteName(suite.yaml)) {
      // Sanity check: the SuiteEntry.suite name should agree with what
      // goSuiteName derives from the basename. If a future YAML is added
      // and the SUITES table forgotten, this catches it.
      throw new Error(
        `[go] suite name mismatch for ${suite.yaml}: ` +
          `entry=${suite.suite} derived=${goSuiteName(suite.yaml)}`,
      );
    }
    const yamlPath = resolve(dataRoot, suite.yaml);
    const cases = loadYamlFile(yamlPath, suite.yaml);
    const { rendered, features } = renderCases(suite, cases);
    const src = renderFile(suite, rendered, features);
    const outPath = resolve(outDir, suite.out);
    writeFileSync(outPath, src);
    written.push({ path: outPath, cases: rendered.length });
  }

  return { written };
}

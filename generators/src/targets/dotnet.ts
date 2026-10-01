// .NET target — generates xUnit test classes under
// sdk-net/tests/Quonfig.Sdk.Tests/Integration/.
//
// Hard rules (set by project owner):
//
//   1. NO auto-skips, NO omissions, NO defensive shortcuts. Every YAML case
//      becomes a real, runnable `[Fact]` method.
//
//   2. Unmapped raise errors and missing input keys FAIL the generator
//      (rather than silently skipping the case at runtime).
//
//   3. PUBLIC API ONLY (qfg-2agi.34). Every case runs through the public
//      `Quonfig` client exactly as a customer would call it, modelled on
//      python.ts:
//        - YAML `type:` picks the typed getter (GetString / GetLong /
//          GetDouble / GetBool / GetStringList / GetJson / GetDuration);
//          `function: enabled` calls IsFeatureEnabled; `get_or_raise` is the
//          typed getter with no default under the default OnNoDefault.Throw.
//        - The context tiers are fed through the SDK's own layering API
//          instead of being pre-merged here: `global` -> QuonfigOptions.
//          GlobalContext, `block` -> client.WithContext(...), `local` -> the
//          per-call contexts argument (or a nested WithContext when a block
//          tier is also present).
//        - Telemetry cases evaluate through the real client with a capturing
//          ITelemetrySender and drain the real reporter by disposing the
//          client; the assertion reads what was actually sent.
//        - Raise cases assert the SDK's specific exception type with
//          Assert.Throws<T> (exact type). The harness never throws on the
//          SDK's behalf and never maps one exception type to another.
//      No test-only resolver, parser, or synthetic config lives in the
//      harness (sdk-net/tests/Quonfig.Sdk.Tests/Integration/TestSetup.cs).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import {
  dotnetSuiteClassName,
  dotnetTestMethodName,
  uniqueSuffix,
} from '../shared/case-id.js';
import { repeatSpec, repeatValueType } from '../shared/repeat.js';
import type { ContextTypes, NormalizedCase, YamlCase } from '../types.js';

interface SuiteEntry {
  yaml: string;
  out: string; // basename of generated file (e.g. "GetTests.cs")
  className: string; // public class name (matches `out` basename without .cs)
}

const SUITES: SuiteEntry[] = [
  { yaml: 'get.yaml', out: 'GetTests.cs', className: 'GetTests' },
  { yaml: 'enabled.yaml', out: 'EnabledTests.cs', className: 'EnabledTests' },
  { yaml: 'get_or_raise.yaml', out: 'GetOrRaiseTests.cs', className: 'GetOrRaiseTests' },
  {
    yaml: 'get_feature_flag.yaml',
    out: 'GetFeatureFlagTests.cs',
    className: 'GetFeatureFlagTests',
  },
  {
    yaml: 'get_weighted_values.yaml',
    out: 'GetWeightedValuesTests.cs',
    className: 'GetWeightedValuesTests',
  },
  {
    yaml: 'context_precedence.yaml',
    out: 'ContextPrecedenceTests.cs',
    className: 'ContextPrecedenceTests',
  },
  {
    yaml: 'enabled_with_contexts.yaml',
    out: 'EnabledWithContextsTests.cs',
    className: 'EnabledWithContextsTests',
  },
  {
    yaml: 'datadir_environment.yaml',
    out: 'DatadirEnvironmentTests.cs',
    className: 'DatadirEnvironmentTests',
  },
  {
    yaml: 'datadir_value_type.yaml',
    out: 'DatadirValueTypeTests.cs',
    className: 'DatadirValueTypeTests',
  },
  {
    yaml: 'delivery_environment.yaml',
    out: 'DeliveryEnvironmentTests.cs',
    className: 'DeliveryEnvironmentTests',
  },
  { yaml: 'post.yaml', out: 'PostTests.cs', className: 'PostTests' },
  { yaml: 'telemetry.yaml', out: 'TelemetryTests.cs', className: 'TelemetryTests' },
  {
    yaml: 'dev_overrides.yaml',
    out: 'DevOverridesTests.cs',
    className: 'DevOverridesTests',
  },
];

const NAMESPACE = 'Quonfig.Sdk.Tests.Integration';
const GENERATOR_PATH = 'integration-test-data/generators/src/targets/dotnet.ts';

// The exceptions sdk-net actually raises, keyed by YAML `expected.error`.
// Target-local on purpose: shared/error-mapping.ts DOTNET_ERRORS maps
// unable_to_coerce_env_var to QuonfigKeyNotFoundException, which hid the
// real QuonfigCoercionException (qfg-2agi.17). Asserting the exact type
// here is what makes the generated suite able to fail on a wrong type.
const DOTNET_ERRORS: Readonly<Record<string, string>> = {
  missing_default: 'QuonfigKeyNotFoundException',
  initialization_timeout: 'QuonfigInitTimeoutException',
  missing_env_var: 'QuonfigEnvVarNotSetException',
  unable_to_coerce_env_var: 'QuonfigCoercionException',
  unable_to_decrypt: 'QuonfigDecryptionException',
  missing_environment: 'InvalidOperationException',
  invalid_environment: 'InvalidOperationException',
};

function errorClass(errKey: string): string {
  if (errKey.length === 0) {
    throw new Error('expected.status: raise but no expected.error provided');
  }
  const cls = DOTNET_ERRORS[errKey];
  if (!cls) {
    throw new Error(`no .NET exception mapping for expected.error="${errKey}" (DOTNET_ERRORS in dotnet.ts)`);
  }
  return cls;
}

// A key that exists in the integration datadir. Context-telemetry cases
// evaluate it so the real client records the context's shape / example.
const TELEMETRY_CONTEXT_PROBE_KEY = 'brand.new.string';

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
}

// ---------------------------------------------------------------------------
// C# literal rendering
// ---------------------------------------------------------------------------

/**
 * Render a value as a C# expression of static type `object?`. Used for JSON
 * values and telemetry expectations, where the SDK hands back nested
 * dictionaries / lists.
 */
export function csLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return formatCsNumber(value);
  if (typeof value === 'string') return csStringLiteral(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'TestSetup.List()';
    return 'TestSetup.List(' + value.map(csLiteral).join(', ') + ')';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 'TestSetup.Map()';
    const args = entries.flatMap(([k, v]) => [csStringLiteral(k), csLiteral(v)]);
    return 'TestSetup.Map(' + args.join(', ') + ')';
  }
  return csStringLiteral(String(value));
}

/**
 * Integers render with an `L` suffix (System.Int64, the SDK's INT type);
 * non-integers with `d`.
 */
function formatCsNumber(n: number): string {
  if (Number.isNaN(n)) return 'double.NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'double.PositiveInfinity' : 'double.NegativeInfinity';
  if (Number.isInteger(n)) return n.toString() + 'L';
  return n.toString() + 'd';
}

function formatCsDouble(n: number): string {
  if (Number.isNaN(n)) return 'double.NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'double.PositiveInfinity' : 'double.NegativeInfinity';
  return n.toString() + 'd';
}

/** Quote a string with double quotes, escaping the usual suspects. */
export function csStringLiteral(s: string): string {
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
      // Surrogate pair — C# string literals are UTF-16 so we need two units.
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

function csStringArray(values: unknown[]): string {
  if (values.length === 0) return 'Array.Empty<string>()';
  return 'new[] { ' + values.map((v) => csStringLiteral(String(v))).join(', ') + ' }';
}

/**
 * Render one tier of YAML contexts as a public `ContextSet` initializer.
 * A null property means "explicitly absent" in the YAML (IS_PRESENT /
 * IS_NOT_PRESENT cases), so it is left out of the context, which is how a
 * customer expresses absence.
 */
function csContextSet(tier: ContextTypes | undefined): string {
  if (!tier || Object.keys(tier).length === 0) return 'new ContextSet()';
  const named: string[] = [];
  for (const [name, props] of Object.entries(tier)) {
    if (!props || typeof props !== 'object') {
      throw new Error(`context "${name}" is not a map`);
    }
    const entries: string[] = [];
    for (const [prop, v] of Object.entries(props)) {
      if (v === null || v === undefined) continue;
      entries.push(`[${csStringLiteral(prop)}] = ${csContextValue(v)}`);
    }
    const inner = entries.length === 0 ? 'new ContextProperties()' : `new ContextProperties { ${entries.join(', ')} }`;
    named.push(`[${csStringLiteral(name)}] = ${inner}`);
  }
  return `new ContextSet { ${named.join(', ')} }`;
}

function csContextValue(v: unknown): string {
  if (typeof v === 'string') return csStringLiteral(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? `new ContextValueLong(${v}L)` : `new ContextValueDouble(${formatCsDouble(v)})`;
  }
  if (Array.isArray(v)) {
    return `new ContextValueStringList(${csStringArray(v)})`;
  }
  throw new Error(`unsupported context value ${JSON.stringify(v)}`);
}

// ---------------------------------------------------------------------------
// Per-suite rendering
// ---------------------------------------------------------------------------

interface RenderedCase {
  source: string;
}

function renderCases(suite: SuiteEntry, cases: NormalizedCase[]): RenderedCase[] {
  const rendered: RenderedCase[] = [];
  const seen = new Map<string, number>();

  for (const nc of cases) {
    const kase = nc.raw;
    const rawName = (kase.name ?? '').toString();
    const methodName = uniqueSuffix(seen, dotnetTestMethodName(rawName));

    let body: string;
    try {
      body = renderBody(suite, kase);
    } catch (e) {
      throw new GeneratorError(`[${suite.yaml}] case "${rawName}": ${(e as Error).message}`);
    }

    rendered.push({
      source:
        `\n` +
        `    [Fact(DisplayName = ${csStringLiteral(rawName)})]\n` +
        `    public async Task ${methodName}()\n` +
        `    {\n` +
        body +
        `    }\n`,
    });
  }
  return rendered;
}

/** Body of one test method (indented eight spaces, trailing newline). */
function renderBody(suite: SuiteEntry, kase: YamlCase): string {
  if (suite.yaml === 'datadir_environment.yaml') return renderDatadirBody(kase);
  if (suite.yaml === 'datadir_value_type.yaml') return renderDatadirValueTypeBody(kase);
  if (suite.yaml === 'delivery_environment.yaml') return renderDeliveryBody(kase);
  if (suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml') return renderTelemetryBody(kase);
  // raw_value_type is a datadir-only field — see datadir_value_type.yaml. A
  // server-mode case carrying it would silently lose the raw-Value assertion,
  // so fail the generator loudly instead.
  if (kase.expected && Object.prototype.hasOwnProperty.call(kase.expected, 'raw_value_type')) {
    throw new Error(`expected.raw_value_type is only valid in datadir_value_type.yaml, not ${suite.yaml}`);
  }
  return renderEvalBody(kase);
}

const I = '        ';

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

/**
 * `await using var client = TestSetup.NewClient(new QuonfigOptions { ... });`
 * TestSetup.NewClient only routes env lookups through the per-test env
 * overrides and turns off what a test must not touch (dev-context
 * injection, datadir file watching, telemetry when no sender is injected).
 */
function renderNewClient(optionInits: string[], indent = I, varName = 'client'): string {
  let out = `${indent}await using var ${varName} = TestSetup.NewClient(new QuonfigOptions\n`;
  out += `${indent}{\n`;
  for (const o of optionInits) out += `${indent}    ${o},\n`;
  out += `${indent}});\n`;
  return out;
}

function datadirOptionInits(): string[] {
  return ['Datadir = TestSetup.DATADIR', 'Environment = TestSetup.ENV_ID'];
}

/**
 * YAML on_no_default follows the Prefab numbering: 1 = raise, 2 = return
 * nil. sdk-net's equivalents are OnNoDefault.Throw (the default) and
 * OnNoDefault.Ignore.
 */
function onNoDefaultEnum(val: unknown): string {
  if (val === 1) return 'OnNoDefault.Throw';
  if (val === 2) return 'OnNoDefault.Ignore';
  throw new Error(`unsupported client_overrides.on_no_default=${JSON.stringify(val)}`);
}

function renderEnvScope(envVars: Record<string, unknown>): string {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return '';
  const args = entries.flatMap(([k, v]) => [
    csStringLiteral(k),
    csStringLiteral(v === null || v === undefined ? '' : String(v)),
  ]);
  return `${I}using var env = TestSetup.Env(${args.join(', ')});\n`;
}

// ---------------------------------------------------------------------------
// Getter calls
// ---------------------------------------------------------------------------

interface Receiver {
  /** Setup lines (e.g. `var scoped = client.WithContext(...)`). */
  setup: string;
  /** Expression the getter is called on. */
  target: string;
  /** Per-call contexts argument, or null when the target is a bound client. */
  callContext: string | null;
  bound: boolean;
}

/**
 * Feed the block / local tiers through the public layering API:
 *   block + local -> client.WithContext(block).WithContext(local)
 *   block         -> client.WithContext(block)
 *   local         -> client.GetX(key, local, ...)
 * The global tier goes into QuonfigOptions.GlobalContext (see
 * renderEvalBody).
 */
function receiverFor(kase: YamlCase, clientVar = 'client'): Receiver {
  const block = kase.contexts?.block;
  const local = kase.contexts?.local;
  const hasBlock = !!block && Object.keys(block).length > 0;
  const hasLocal = !!local && Object.keys(local).length > 0;
  if (hasBlock) {
    let setup = `${I}var scoped = ${clientVar}.WithContext(${csContextSet(block)});\n`;
    if (hasLocal) {
      setup = `${I}var scoped = ${clientVar}.WithContext(${csContextSet(block)})\n${I}    .WithContext(${csContextSet(local)});\n`;
    }
    return { setup, target: 'scoped', callContext: null, bound: true };
  }
  if (hasLocal) {
    return { setup: '', target: clientVar, callContext: csContextSet(local), bound: false };
  }
  return { setup: '', target: clientVar, callContext: null, bound: false };
}

interface GetterSpec {
  method: string;
  renderDefault: (v: unknown) => string;
}

const GETTERS: Record<string, GetterSpec> = {
  STRING: { method: 'GetString', renderDefault: (v) => csStringLiteral(String(v)) },
  INT: {
    method: 'GetLong',
    renderDefault: (v) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`INT default must be an integer, got ${JSON.stringify(v)}`);
      return `${v}L`;
    },
  },
  DOUBLE: {
    method: 'GetDouble',
    renderDefault: (v) => {
      if (typeof v !== 'number') throw new Error(`DOUBLE default must be a number, got ${JSON.stringify(v)}`);
      return formatCsDouble(v);
    },
  },
  BOOLEAN: {
    method: 'GetBool',
    renderDefault: (v) => {
      if (typeof v !== 'boolean') throw new Error(`BOOLEAN default must be a bool, got ${JSON.stringify(v)}`);
      return v ? 'true' : 'false';
    },
  },
  STRING_LIST: {
    method: 'GetStringList',
    renderDefault: (v) => {
      if (!Array.isArray(v)) throw new Error(`STRING_LIST default must be a list, got ${JSON.stringify(v)}`);
      return csStringArray(v);
    },
  },
  JSON: { method: 'GetJson', renderDefault: (v) => csLiteral(v) },
  // input.default on a DURATION case is integer milliseconds (get.yaml).
  DURATION: {
    method: 'GetDuration',
    renderDefault: (v) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`DURATION default must be integer ms, got ${JSON.stringify(v)}`);
      return `TimeSpan.FromTicks(${v}L * TimeSpan.TicksPerMillisecond)`;
    },
  },
};

function yamlTypeOf(kase: YamlCase): string {
  if (kase.type === undefined || kase.type === null) {
    throw new Error('case has no `type:`; the typed getter cannot be chosen');
  }
  const t = kase.type.toString().toUpperCase();
  if (!GETTERS[t]) throw new Error(`unsupported type: ${t}`);
  return t;
}

/** Build `<target>.<Method>(key[, ctx][, defaultValue: d])`, optionally a Details variant. */
function getterCall(kase: YamlCase, recv: Receiver, key: string, details = false): string {
  const input = kase.input ?? {};
  const func = (kase.function ?? 'get').toString();
  const keyLit = csStringLiteral(key);

  if (func === 'enabled') {
    if (details) throw new Error('enabled has no Details variant');
    const args = [keyLit];
    if (recv.callContext) args.push(recv.callContext);
    return `${recv.target}.IsFeatureEnabled(${args.join(', ')})`;
  }
  if (func !== 'get' && func !== 'get_or_raise') {
    throw new Error(`unsupported function: ${func}`);
  }
  const spec = GETTERS[yamlTypeOf(kase)]!;
  const args = [keyLit];
  if (recv.callContext) args.push(recv.callContext);
  if (Object.prototype.hasOwnProperty.call(input, 'default')) {
    args.push(`defaultValue: ${spec.renderDefault((input as { default?: unknown }).default)}`);
  }
  return `${recv.target}.${spec.method}${details ? 'Details' : ''}(${args.join(', ')})`;
}

function caseKey(kase: YamlCase): string {
  const input = kase.input ?? {};
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag');
  }
  return key.toString();
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function renderValueAssertion(kase: YamlCase, actualExpr: string): string {
  const expected = kase.expected ?? {};
  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('case has no expected.value or expected.millis');
  }
  const v = expected.value;
  const func = (kase.function ?? 'get').toString();
  const t = func === 'enabled' ? 'BOOLEAN' : yamlTypeOf(kase);

  let out = `${I}var actual = ${actualExpr};\n`;
  if (v === null || v === undefined) {
    if (func === 'enabled') throw new Error('IsFeatureEnabled returns bool; expected.value cannot be null');
    return out + `${I}Assert.Null(actual);\n`;
  }
  switch (t) {
    case 'BOOLEAN':
      if (typeof v !== 'boolean') throw new Error(`BOOLEAN case expects a bool, got ${JSON.stringify(v)}`);
      return out + `${I}Assert.${v ? 'True' : 'False'}(actual);\n`;
    case 'INT':
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`INT case expects an integer, got ${JSON.stringify(v)}`);
      return out + `${I}Assert.Equal(${v}L, actual);\n`;
    case 'DOUBLE':
      if (typeof v !== 'number') throw new Error(`DOUBLE case expects a number, got ${JSON.stringify(v)}`);
      return out + `${I}TestSetup.AssertDoubleEquals(${formatCsDouble(v)}, actual);\n`;
    case 'STRING':
      if (typeof v !== 'string') throw new Error(`STRING case expects a string, got ${JSON.stringify(v)}`);
      return out + `${I}Assert.Equal(${csStringLiteral(v)}, actual);\n`;
    case 'STRING_LIST':
      if (!Array.isArray(v)) throw new Error(`STRING_LIST case expects a list, got ${JSON.stringify(v)}`);
      return out + `${I}Assert.Equal(${csStringArray(v)}, actual);\n`;
    case 'JSON':
      return out + `${I}Assert.Equal(${csLiteral(v)}, actual);\n`;
    case 'DURATION':
      throw new Error('DURATION cases assert expected.millis (or a null value)');
    default:
      throw new Error(`unsupported type ${t}`);
  }
}

/**
 * DURATION: integer-exact milliseconds through GetDuration AND
 * GetDurationDetails (qfg-2agi.4). With no default the Details reason must
 * not be Error; with a default (malformed-value cases) the default is
 * returned and the reason is not asserted.
 */
function renderDurationAssertion(kase: YamlCase, recv: Receiver, key: string): string {
  const expected = kase.expected ?? {};
  const millis = expected.millis;
  if (typeof millis !== 'number' || !Number.isInteger(millis)) {
    throw new Error('expected.millis must be an integer');
  }
  if (yamlTypeOf(kase) !== 'DURATION') {
    throw new Error('expected.millis is only valid on DURATION cases');
  }
  const hasDefault = Object.prototype.hasOwnProperty.call(kase.input ?? {}, 'default');
  const want = `TimeSpan.FromTicks(${millis}L * TimeSpan.TicksPerMillisecond)`;
  let out = '';
  out += `${I}Assert.Equal(${want}, ${getterCall(kase, recv, key)});\n`;
  out += `${I}var details = ${getterCall(kase, recv, key, true)};\n`;
  out += `${I}Assert.Equal(${want}, details.Value);\n`;
  if (!hasDefault) {
    out += `${I}Assert.NotEqual(Reason.Error, details.Reason);\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Eval-style body (get / enabled / get_or_raise / contexts / weighted)
// ---------------------------------------------------------------------------

function renderEvalBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars ?? {};
  const isRaise = expected.status === 'raise';
  const key = caseKey(kase);

  if (hasHttpOverrides(overrides)) {
    return renderHttpClientBody(kase, key);
  }

  const opts = datadirOptionInits();
  const global = kase.contexts?.global;
  if (global && Object.keys(global).length > 0) {
    opts.push(`GlobalContext = ${csContextSet(global)}`);
  }
  if ('on_no_default' in overrides) {
    opts.push(`OnNoDefault = ${onNoDefaultEnum(overrides.on_no_default)}`);
  }
  for (const k of Object.keys(overrides)) {
    if (k !== 'on_no_default') throw new Error(`unsupported client_overrides.${k} on an eval case`);
  }

  let body = renderEnvScope(envVars);
  body += renderNewClient(opts);
  const recv = receiverFor(kase);
  body += recv.setup;

  // repeat + values_seen (qfg-t9wo): evaluate N times through the public
  // getter, assert the SET of values seen equals values_seen exactly.
  const rspec = repeatSpec(kase);
  if (rspec) {
    if (isRaise) throw new Error('`repeat` cannot be combined with a raise expectation');
    repeatValueType(kase, rspec);
    const want = rspec.valuesSeen.map((v) => csLiteral(v)).join(', ');
    body += `${I}var seen = new HashSet<object?>();\n`;
    body += `${I}for (var i = 0; i < ${rspec.repeat}; i++)\n`;
    body += `${I}{\n`;
    body += `${I}    seen.Add(${getterCall(kase, recv, key)});\n`;
    body += `${I}}\n`;
    body += `${I}Assert.True(\n`;
    body += `${I}    seen.SetEquals(new object?[] { ${want} }),\n`;
    body += `${I}    $"values seen over ${rspec.repeat} evaluations: {string.Join(", ", seen)}");\n`;
    return body;
  }

  if (isRaise) {
    const cls = errorClass((expected.error ?? '').toString());
    body += `${I}Assert.Throws<${cls}>(() => ${getterCall(kase, recv, key)});\n`;
    return body;
  }

  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    body += renderDurationAssertion(kase, recv, key);
    return body;
  }

  body += renderValueAssertion(kase, getterCall(kase, recv, key));
  return body;
}

function hasHttpOverrides(overrides: unknown): boolean {
  if (!overrides || typeof overrides !== 'object') return false;
  const o = overrides as Record<string, unknown>;
  return 'initialization_timeout_sec' in o || 'prefab_api_url' in o || 'on_init_failure' in o;
}

/**
 * client_overrides with an init timeout / unreachable API URL: build a real
 * delivery-mode client and drive InitAsync + the getter exactly as a
 * customer would.
 */
function renderHttpClientBody(kase: YamlCase, key: string): string {
  const expected = kase.expected ?? {};
  const overrides = kase.client_overrides ?? {};
  const isRaise = expected.status === 'raise';
  const errKey = (expected.error ?? '').toString();

  const onInit = typeof overrides.on_init_failure === 'string' ? overrides.on_init_failure.replace(/^:/, '') : 'raise';
  if (onInit !== 'raise' && onInit !== 'return') {
    throw new Error(`unsupported on_init_failure=${onInit}`);
  }
  const timeoutSec =
    typeof overrides.initialization_timeout_sec === 'number' ? overrides.initialization_timeout_sec : 0.01;
  const apiURL = typeof overrides.prefab_api_url === 'string' ? overrides.prefab_api_url : 'http://10.255.255.1:8080';

  const opts = [
    'SdkKey = "integration-tests"',
    `ApiUrls = new[] { ${csStringLiteral(apiURL)} }`,
    // No SSE / fallback polling against the unreachable URL.
    'StreamUrls = Array.Empty<string>()',
    'FallbackPollEnabled = false',
    `InitTimeout = TimeSpan.FromMilliseconds(${Math.max(1, Math.round(timeoutSec * 1000))})`,
    `OnInitFailure = ${onInit === 'return' ? 'OnInitFailure.ReturnDefaults' : 'OnInitFailure.Throw'}`,
  ];

  let body = renderNewClient(opts);
  const recv = receiverFor(kase);
  if (isRaise && errKey === 'initialization_timeout') {
    body += `${I}await Assert.ThrowsAsync<${errorClass(errKey)}>(() => client.InitAsync());\n`;
    return body;
  }
  body += `${I}await client.InitAsync();\n`;
  body += recv.setup;
  if (isRaise) {
    body += `${I}Assert.Throws<${errorClass(errKey)}>(() => ${getterCall(kase, recv, key)});\n`;
    return body;
  }
  return body + renderValueAssertion(kase, getterCall(kase, recv, key));
}

// ---------------------------------------------------------------------------
// datadir_environment.yaml
// ---------------------------------------------------------------------------

function datadirOverrideInits(kase: YamlCase): string[] {
  const overrides = kase.client_overrides ?? {};
  const opts: string[] = [];
  for (const k of Object.keys(overrides)) {
    if (k !== 'datadir' && k !== 'environment') throw new Error(`unsupported client_overrides.${k} on a datadir case`);
  }
  if ('datadir' in overrides) {
    if (overrides.datadir !== 'integration-tests') {
      throw new Error(`unsupported client_overrides.datadir=${JSON.stringify(overrides.datadir)}`);
    }
    opts.push('Datadir = TestSetup.DATADIR');
  }
  if ('environment' in overrides) {
    opts.push(`Environment = ${csStringLiteral(String(overrides.environment))}`);
  }
  return opts;
}

function renderDatadirBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const func = (kase.function ?? 'get').toString();
  const opts = datadirOverrideInits(kase);

  let body = renderEnvScope(kase.env_vars ?? {});
  if (func === 'init') {
    if (expected.status !== 'raise') throw new Error('init case without a raise expectation');
    const cls = errorClass((expected.error ?? '').toString());
    body += `${I}var options = new QuonfigOptions\n${I}{\n`;
    for (const o of opts) body += `${I}    ${o},\n`;
    body += `${I}};\n`;
    body += `${I}Assert.Throws<${cls}>(() => TestSetup.NewClient(options));\n`;
    body += `${I}await Task.CompletedTask;\n`;
    return body;
  }
  const key = caseKey(kase);
  body += renderNewClient(opts);
  body += renderValueAssertion(kase, getterCall(kase, receiverFor(kase), key));
  return body;
}

// ---------------------------------------------------------------------------
// datadir_value_type.yaml
// ---------------------------------------------------------------------------

/**
 * Asserts the public typed getter's value and, when
 * `expected.raw_value_type == "number"`, that the datadir loader produced a
 * real number (not a string) for the key. The public getters coerce a
 * numeric string, so only the loaded envelope can show the difference.
 */
function renderDatadirValueTypeBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const rawType = expected.raw_value_type;
  if (rawType !== undefined && rawType !== 'number') {
    throw new Error(
      `unsupported expected.raw_value_type=${JSON.stringify(rawType)} (only "number" is supported)`,
    );
  }
  const key = caseKey(kase);
  const opts = datadirOverrideInits(kase);
  let body = renderNewClient(opts);
  body += renderValueAssertion(kase, getterCall(kase, receiverFor(kase), key));
  if (rawType === 'number') {
    const env = 'environment' in (kase.client_overrides ?? {}) ? csStringLiteral(String(kase.client_overrides!.environment)) : 'TestSetup.ENV_ID';
    body += `${I}TestSetup.AssertLoadedValueNumeric(${env}, ${csStringLiteral(key)});\n`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// delivery_environment.yaml (self-contained WireMock server)
// ---------------------------------------------------------------------------

/**
 * Cross-SDK DELIVERY-WIRE-SHAPE gate (qfg-xpln): stands up a WireMock server
 * returning the literal `envelope` JSON on /api/v2/configs, builds a real
 * Quonfig in SDK-key mode (NO Environment pin unless
 * client_overrides.environment is set), awaits InitAsync, and asserts the
 * typed getter's value.
 */
function renderDeliveryBody(kase: YamlCase): string {
  const overrides = kase.client_overrides ?? {};
  const envelope = kase.envelope;
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('delivery case has no `envelope` wire shape');
  }
  if (!('sdk_key' in overrides)) {
    throw new Error('delivery case must set client_overrides.sdk_key (SDK-key mode)');
  }
  const key = caseKey(kase);

  const opts: string[] = [
    `SdkKey = ${csStringLiteral(String(overrides.sdk_key))}`,
    `ApiUrls = new[] { server.Urls[0] }`,
    `StreamUrls = Array.Empty<string>()`,
    `FallbackPollEnabled = false`,
    `InitTimeout = TimeSpan.FromSeconds(5)`,
  ];
  if ('environment' in overrides) {
    opts.push(`Environment = ${csStringLiteral(String(overrides.environment))}`);
  }

  let body = '';
  body += `${I}using var server = WireMockServer.Start();\n`;
  body += `${I}server\n`;
  body += `${I}    .Given(Request.Create().WithPath("/api/v2/configs").UsingGet())\n`;
  body += `${I}    .RespondWith(Response.Create().WithStatusCode(200)\n`;
  body += `${I}        .WithHeader("Content-Type", "application/json")\n`;
  body += `${I}        .WithHeader("ETag", "\\"v1\\"")\n`;
  body += `${I}        .WithBody(${csStringLiteral(JSON.stringify(envelope))}));\n`;
  body += `\n`;
  body += renderNewClient(opts);
  body += `${I}await client.InitAsync();\n`;
  body += `\n`;
  body += renderValueAssertion(kase, getterCall(kase, receiverFor(kase), key));
  return body;
}

// ---------------------------------------------------------------------------
// post.yaml / telemetry.yaml
// ---------------------------------------------------------------------------

function contextUploadModeEnum(raw: unknown): string {
  const s = String(raw).replace(/^:/, '').toLowerCase();
  if (s === 'none') return 'ContextUploadMode.None';
  if (s === 'shape_only' || s === 'shapes_only') return 'ContextUploadMode.ShapesOnly';
  if (s === 'periodic_example') return 'ContextUploadMode.PeriodicExample';
  throw new Error(`unsupported context_upload_mode=${JSON.stringify(raw)}`);
}

/**
 * Evaluate through a real datadir client whose ITelemetrySender captures
 * what the reporter sends; disposing the client drains the reporter (one
 * POST of the live window). The assertion reads the captured wire payload,
 * normalized to the YAML's expected_data shape.
 */
function renderTelemetryBody(kase: YamlCase): string {
  const aggregator = (kase.aggregator ?? '').toString();
  if (!['context_shape', 'evaluation_summary', 'example_contexts'].includes(aggregator)) {
    throw new Error(`unsupported aggregator=${JSON.stringify(aggregator)}`);
  }
  if ((kase.endpoint ?? '').toString().length === 0) {
    throw new Error('post/telemetry case missing endpoint');
  }
  const overrides = kase.client_overrides ?? {};
  const data = Object.prototype.hasOwnProperty.call(kase, 'data') ? kase.data : null;
  const expectedData = Object.prototype.hasOwnProperty.call(kase, 'expected_data') ? kase.expected_data : null;

  const opts = [...datadirOptionInits(), 'TelemetrySender = telemetry.Sender'];
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'context_upload_mode') opts.push(`ContextUploadMode = ${contextUploadModeEnum(v)}`);
    else if (k === 'collect_evaluation_summaries') {
      if (typeof v !== 'boolean') throw new Error('collect_evaluation_summaries must be a bool');
      opts.push(`CollectEvaluationSummaries = ${v ? 'true' : 'false'}`);
    } else throw new Error(`unsupported client_overrides.${k} on a telemetry case`);
  }
  if (kase.contexts?.global || kase.contexts?.local) {
    throw new Error('telemetry cases support only the block context tier');
  }

  const J = I + '    ';
  let calls = '';
  if (aggregator === 'evaluation_summary') {
    const d = (data ?? {}) as Record<string, unknown>;
    const keys = Array.isArray(d.keys) ? d.keys : [];
    const without = Array.isArray(d.keys_without_context) ? d.keys_without_context : [];
    for (const k of Object.keys(d)) {
      if (k !== 'keys' && k !== 'keys_without_context') throw new Error(`unsupported data.${k}`);
    }
    if (keys.length > 0) {
      calls += `${J}var scoped = client.WithContext(${csContextSet(kase.contexts?.block)});\n`;
      for (const k of keys) calls += `${J}telemetry.Evaluate(scoped, ${csStringLiteral(String(k))});\n`;
    }
    if (without.length > 0) {
      calls += `${J}var unscoped = client.WithContext(new ContextSet());\n`;
      for (const k of without) calls += `${J}telemetry.Evaluate(unscoped, ${csStringLiteral(String(k))});\n`;
    }
  } else {
    if (kase.contexts?.block) throw new Error('context telemetry cases take their contexts from data');
    const records = Array.isArray(data) ? data : [data ?? {}];
    for (const r of records) {
      calls += `${J}telemetry.Evaluate(client.WithContext(${csContextSet(r as ContextTypes)}), ${csStringLiteral(TELEMETRY_CONTEXT_PROBE_KEY)});\n`;
    }
  }

  let body = `${I}var telemetry = new TestSetup.TelemetryCapture();\n`;
  body += `${I}await using (var client = TestSetup.NewClient(new QuonfigOptions\n`;
  body += `${I}{\n`;
  for (const o of opts) body += `${I}    ${o},\n`;
  body += `${I}}))\n`;
  body += `${I}{\n`;
  body += calls;
  body += `${I}}\n`;
  const post = `telemetry.Sent(${csStringLiteral(aggregator)})`;
  if (expectedData === null || expectedData === undefined) {
    body += `${I}Assert.Null(${post});\n`;
  } else {
    body += `${I}Assert.Equal(${csLiteral(expectedData)}, ${post});\n`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function renderFile(suite: SuiteEntry, rendered: RenderedCase[]): string {
  const src = rendered.map((r) => r.source).join('');
  const usings = new Set<string>(['System', 'System.Threading.Tasks', 'Xunit']);
  if (/\bHashSet<\b/.test(src)) usings.add('System.Collections.Generic');
  if (/\bQuonfig[A-Za-z]*Exception\b/.test(src)) usings.add('Quonfig.Sdk.Exceptions');
  if (/\bWireMockServer\b/.test(src)) {
    usings.add('WireMock.RequestBuilders');
    usings.add('WireMock.ResponseBuilders');
    usings.add('WireMock.Server');
  }
  const sorted = Array.from(usings).sort((a, b) => {
    const aSystem = a === 'System' || a.startsWith('System.');
    const bSystem = b === 'System' || b.startsWith('System.');
    if (aSystem && !bSystem) return -1;
    if (!aSystem && bSystem) return 1;
    return a.localeCompare(b);
  });

  let out = '';
  out += `// AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=dotnet\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;
  for (const ns of sorted) out += `using ${ns};\n`;
  out += `\n`;
  out += `namespace ${NAMESPACE};\n`;
  out += `\n`;
  out += `public sealed class ${suite.className}\n`;
  out += `{\n`;
  out += src;
  out += `}\n`;
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DotnetRunResult {
  written: { path: string; cases: number }[];
}

/**
 * @param dataRoot integration-test-data/tests/eval (absolute)
 * @param outDir   sdk-net/tests/Quonfig.Sdk.Tests/Integration (absolute)
 */
export function runDotnetTarget(dataRoot: string, outDir: string): DotnetRunResult {
  mkdirSync(outDir, { recursive: true });
  const written: DotnetRunResult['written'] = [];

  for (const suite of SUITES) {
    if (suite.className !== dotnetSuiteClassName(suite.yaml)) {
      throw new Error(
        `[dotnet] class name mismatch for ${suite.yaml}: ` +
          `entry=${suite.className} derived=${dotnetSuiteClassName(suite.yaml)}`,
      );
    }
    const cases = loadYamlFile(resolve(dataRoot, suite.yaml), suite.yaml);
    const rendered = renderCases(suite, cases);
    const outPath = resolve(outDir, suite.out);
    writeFileSync(outPath, renderFile(suite, rendered));
    written.push({ path: outPath, cases: rendered.length });
  }

  return { written };
}

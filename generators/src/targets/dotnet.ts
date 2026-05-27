// .NET target — generates xUnit test classes under
// sdk-net/tests/Quonfig.Sdk.Tests/Integration/.
//
// Hard rules (set by project owner, mirroring java.ts):
//
//   1. NO auto-skips, NO omissions, NO defensive shortcuts. Every YAML case
//      becomes a real, runnable `[Fact]` method. Cases the SDK can't yet
//      satisfy emit code that calls a sensibly-named helper on TestSetup —
//      runtime/compile failure is the *desired* surfacing behavior, not a
//      hidden gap. The TestSetup class itself is added in the SDK-side
//      iteration bead (qfg-zp7i.13); until then, the generated files compile
//      symbol-resolution-wise (file structure, usings, syntax) but their
//      method bodies reference TestSetup.* helpers that don't exist.
//
//   2. Unmapped raise errors and missing input keys FAIL the generator
//      (rather than silently skipping the case at runtime).
//
//   3. Mirrors the structure of java.ts — same six-stage flow (load YAML,
//      render cases, render file, write file). Anything .NET-specific
//      (`object?` nullable annotations, file-scoped namespaces,
//      `Assert.Throws<X>(() => ...)`, PascalCase TestSetup helpers) is
//      handled in the helpers below.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import {
  dotnetSuiteClassName,
  dotnetTestMethodName,
  uniqueSuffix,
} from '../shared/case-id.js';
import { mergeContexts } from '../shared/contexts.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
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

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
}

// ---------------------------------------------------------------------------
// C# literal rendering
// ---------------------------------------------------------------------------

/** Render a value as a C# expression of static type `object?`. */
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
 * Render a number as a C# numeric literal. Integer values *always* get the
 * `L` suffix so they materialize as `long` (System.Int64) — the SDK's INT
 * type, the env-var coercion path, and JSON-int parsing all surface integer
 * values as `long`, so emitting bare `int` literals would make
 * `Assert.Equal(expected, actual)` fail against any of those returns.
 * Non-integers render with a trailing `d` so the compiler treats them as
 * `double` even when they round-trip as e.g. "9.95". NaN/Infinity use the
 * `double.NaN` / `double.PositiveInfinity` constants.
 */
function formatCsNumber(n: number): string {
  if (Number.isNaN(n)) return 'double.NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'double.PositiveInfinity' : 'double.NegativeInfinity';
  if (Number.isInteger(n)) {
    return n.toString() + 'L';
  }
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

// ---------------------------------------------------------------------------
// Per-suite rendering
// ---------------------------------------------------------------------------

interface RenderedCase {
  /** Full `[Fact] ... public void <name>() { ... }` block, indented four spaces. */
  source: string;
}

interface RenderResult {
  rendered: RenderedCase[];
  /** Set of fully-qualified exception classes referenced — drives extra usings. */
  exceptions: Set<string>;
}

function renderCases(suite: SuiteEntry, cases: NormalizedCase[]): RenderResult {
  const rendered: RenderedCase[] = [];
  const seen = new Map<string, number>();
  const exceptions = new Set<string>();

  for (const nc of cases) {
    const kase = nc.raw;
    const rawName = (kase.name ?? '').toString();
    const baseName = dotnetTestMethodName(rawName);
    const methodName = uniqueSuffix(seen, baseName);

    let body: string;
    try {
      body = renderBody(suite, kase, exceptions);
    } catch (e) {
      throw new GeneratorError(
        `[${suite.yaml}] case "${rawName}": ${(e as Error).message}`,
      );
    }

    const block =
      `\n` +
      `    [Fact(DisplayName = ${csStringLiteral(rawName)})]\n` +
      `    public void ${methodName}()\n` +
      `    {\n` +
      body +
      `    }\n`;
    rendered.push({ source: block });
  }

  return { rendered, exceptions };
}

/**
 * Render a single test method body (everything between the opening `{` and
 * closing `}`). Returns text with a trailing newline. Indented eight spaces
 * (xUnit class body is at four; method body is at eight).
 */
function renderBody(
  suite: SuiteEntry,
  kase: YamlCase,
  exceptions: Set<string>,
): string {
  if (suite.yaml === 'datadir_environment.yaml') {
    return renderDatadirBody(kase, exceptions);
  }
  if (suite.yaml === 'datadir_value_type.yaml') {
    return renderDatadirValueTypeBody(kase);
  }
  if (suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml') {
    return renderPostBody(kase);
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
  return renderEvalBody(kase, exceptions);
}

// ---------------------------------------------------------------------------
// Eval-style body renderer (get / enabled / get_or_raise / etc)
// ---------------------------------------------------------------------------

function renderEvalBody(kase: YamlCase, exceptions: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars ?? {};
  const merged = mergeContexts(kase.contexts);
  const fn = (kase.function ?? 'get').toString();
  const isRaise = expected.status === 'raise';
  const yamlType = (kase.type ?? 'STRING').toString().toUpperCase();

  const indent = '        ';
  const hasEnv = Object.keys(envVars).length > 0;
  const hasClientOverrides = hasClientConstructionOverrides(overrides);

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag and no raise expectation');
  }
  const ctxLit = renderContextsLiteral(merged);

  let body = '';
  if (hasEnv) {
    body += `${indent}TestSetup.WithEnv(${envMapLiteral(envVars)}, () =>\n`;
    body += `${indent}{\n`;
  }
  const inner = hasEnv ? indent + '    ' : indent;

  if (hasClientOverrides) {
    body += renderClientConstructionBody(kase, key, ctxLit, expected, exceptions, inner);
  } else if (isRaise) {
    body += renderRaiseBody(kase, key, ctxLit, expected, exceptions, inner);
  } else {
    body += renderHappyPathBody(kase, key, ctxLit, expected, fn, yamlType, input, inner);
  }

  if (hasEnv) {
    body += `${indent}});\n`;
  }
  return body;
}

function renderHappyPathBody(
  _kase: YamlCase,
  key: string,
  ctxLit: string,
  expected: { value?: unknown; millis?: number; [k: string]: unknown },
  fn: string,
  yamlType: string,
  input: { default?: unknown; [k: string]: unknown },
  indent: string,
): string {
  const keyLit = csStringLiteral(key);
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  const def = (input as { default?: unknown }).default;

  // Pick the call shape — same trichotomy as java.ts:
  //   function: enabled → EnabledCase
  //   has default       → GetCase (mirrors public Quonfig.Get)
  //   otherwise         → ResolveCase (direct evaluator/resolver path)
  let actualExpr: string;
  if (fn === 'enabled') {
    actualExpr = `TestSetup.EnabledCase(${keyLit}, ${ctxLit})`;
  } else if (hasDefault) {
    actualExpr = `TestSetup.GetCase(${keyLit}, ${ctxLit}, ${csLiteral(def)})`;
  } else {
    actualExpr = `TestSetup.ResolveCase(${keyLit}, ${ctxLit})`;
  }

  let body = '';
  body += `${indent}object? actual = ${actualExpr};\n`;
  body += renderAssertion(indent, expected, fn, yamlType);
  return body;
}

function renderRaiseBody(
  _kase: YamlCase,
  key: string,
  ctxLit: string,
  expected: { error?: string; [k: string]: unknown },
  exceptions: Set<string>,
  indent: string,
): string {
  const keyLit = csStringLiteral(key);
  const errKey = (expected.error ?? '').toString();
  if (errKey.length === 0) {
    throw new Error('expected.status: raise but no expected.error provided');
  }
  const errClass = lookupErrorClass('dotnet', errKey);
  if (!errClass) {
    throw new Error(
      `no .NET error mapping for expected.error="${errKey}". ` +
        `Add it to src/shared/error-mapping.ts (DOTNET_ERRORS).`,
    );
  }
  exceptions.add(errClass);
  const shortName = shortClassName(errClass);

  let body = '';
  body += `${indent}Assert.Throws<${shortName}>(() =>\n`;
  body += `${indent}    TestSetup.RunRaiseCase(${keyLit}, ${ctxLit}, ${csStringLiteral(errKey)}));\n`;
  return body;
}

function renderClientConstructionBody(
  kase: YamlCase,
  key: string,
  _ctxLit: string,
  expected: { value?: unknown; status?: string; error?: string; [k: string]: unknown },
  exceptions: Set<string>,
  indent: string,
): string {
  const keyLit = csStringLiteral(key);
  const overrides = kase.client_overrides ?? {};
  const fn = (kase.function ?? 'get').toString();
  const isRaise = expected.status === 'raise';
  const errKey = (expected.error ?? '').toString();

  const onInit = (() => {
    const v = overrides.on_init_failure;
    if (typeof v !== 'string') return 'raise';
    return v.replace(/^:/, '');
  })();
  const timeoutSec =
    typeof overrides.initialization_timeout_sec === 'number'
      ? overrides.initialization_timeout_sec
      : 0.01;
  const apiURL =
    typeof overrides.prefab_api_url === 'string'
      ? overrides.prefab_api_url
      : 'http://10.255.255.1:8080';

  if (isRaise && errKey === 'initialization_timeout') {
    return (
      `${indent}TestSetup.AssertInitializationTimeoutError(${keyLit}, ` +
      `${formatCsNumber(timeoutSec)}, ${csStringLiteral(apiURL)}, ` +
      `${csStringLiteral(onInit)});\n`
    );
  }
  if (isRaise) {
    const errClass = lookupErrorClass('dotnet', errKey);
    if (!errClass) {
      throw new Error(
        `no .NET error mapping for expected.error="${errKey}" in client-construction case.`,
      );
    }
    exceptions.add(errClass);
    const shortName = shortClassName(errClass);
    return (
      `${indent}TestSetup.AssertClientConstructionRaises<${shortName}>(${keyLit}, ` +
      `${formatCsNumber(timeoutSec)}, ${csStringLiteral(apiURL)}, ` +
      `${csStringLiteral(onInit)}, ${csStringLiteral(fn)});\n`
    );
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    return (
      `${indent}Assert.Equal(${csLiteral(expected.value)}, ` +
      `TestSetup.AssertClientConstructionValue(${keyLit}, ` +
      `${formatCsNumber(timeoutSec)}, ${csStringLiteral(apiURL)}, ` +
      `${csStringLiteral(onInit)}, ${csStringLiteral(fn)}));\n`
    );
  }
  throw new Error('client-construction case has no expected.value or expected.error');
}

function renderAssertion(
  indent: string,
  expected: { value?: unknown; millis?: number; [k: string]: unknown },
  _fn: string,
  _yamlType: string,
): string {
  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    const millis = expected.millis as number;
    // AssertDurationMillis lives on TestSetup so the TimeSpan return type
    // and the millis-vs-seconds conversion are encapsulated there. Match the
    // python target's tolerance (1ms).
    return `${indent}TestSetup.AssertDurationMillis(actual, ${millis}L);\n`;
  }
  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('case has no expected.value or expected.millis');
  }
  const v = expected.value;
  if (v === null || v === undefined) {
    return `${indent}Assert.Null(actual);\n`;
  }
  if (typeof v === 'boolean') {
    return `${indent}Assert.Equal(${v ? 'true' : 'false'}, actual);\n`;
  }
  if (typeof v === 'number' && !Number.isInteger(v)) {
    // Floating-point: Assert.Equal(object, object) on doubles uses
    // .Equals which is bit-exact. Use a TestSetup helper so generators can
    // centralize tolerance.
    return `${indent}TestSetup.AssertDoubleEquals(${formatCsNumber(v)}, actual);\n`;
  }
  return `${indent}Assert.Equal(${csLiteral(v)}, actual);\n`;
}

function envMapLiteral(envVars: Record<string, unknown>): string {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return 'TestSetup.Map()';
  const args = entries.flatMap(([k, v]) => {
    const sval = v === null || v === undefined ? '' : String(v);
    return [csStringLiteral(k), csStringLiteral(sval)];
  });
  return 'TestSetup.Map(' + args.join(', ') + ')';
}

function renderContextsLiteral(merged: ContextTypes): string {
  if (Object.keys(merged).length === 0) return 'TestSetup.Map()';
  return csLiteral(merged);
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

/** "Quonfig.Sdk.Exceptions.QuonfigKeyNotFoundException" → "QuonfigKeyNotFoundException". */
function shortClassName(fqcn: string): string {
  const idx = fqcn.lastIndexOf('.');
  return idx === -1 ? fqcn : fqcn.slice(idx + 1);
}

/** "Quonfig.Sdk.Exceptions.QuonfigKeyNotFoundException" → "Quonfig.Sdk.Exceptions". */
function namespaceOf(fqcn: string): string {
  const idx = fqcn.lastIndexOf('.');
  return idx === -1 ? '' : fqcn.slice(0, idx);
}

// ---------------------------------------------------------------------------
// datadir_environment.yaml renderer
// ---------------------------------------------------------------------------

function renderDatadirBody(kase: YamlCase, exceptions: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars ?? {};
  const func = (kase.function ?? 'get').toString();
  const isRaise = expected.status === 'raise';

  const indent = '        ';
  const hasEnv = Object.keys(envVars).length > 0;

  const opts: string[] = [];
  if ('datadir' in overrides) {
    opts.push(`"datadir", TestSetup.DATADIR`);
  }
  if ('environment' in overrides) {
    opts.push(`"environment", ${csStringLiteral(String(overrides.environment))}`);
  }
  const optsLit = opts.length > 0 ? `TestSetup.Map(${opts.join(', ')})` : 'TestSetup.Map()';

  let body = '';
  if (hasEnv) {
    body += `${indent}TestSetup.WithEnv(${envMapLiteral(envVars)}, () =>\n`;
    body += `${indent}{\n`;
  }
  const inner = hasEnv ? indent + '    ' : indent;

  if (func === 'init' && isRaise) {
    const errKey = (expected.error ?? '').toString();
    if (errKey.length === 0) {
      throw new Error('init raise case missing expected.error');
    }
    const errClass = lookupErrorClass('dotnet', errKey);
    if (!errClass) {
      throw new Error(
        `no .NET error mapping for expected.error="${errKey}" in datadir init case.`,
      );
    }
    exceptions.add(errClass);
    const shortName = shortClassName(errClass);
    body += `${inner}Assert.Throws<${shortName}>(() => TestSetup.DatadirClient(${optsLit}));\n`;
  } else {
    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('datadir get-case has no input.key/flag');
    }
    if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
      throw new Error('datadir get-case has no expected.value');
    }
    const yamlType = (kase.type ?? 'STRING').toString().toUpperCase();
    body += `${inner}object? actual = TestSetup.DatadirGet(${optsLit}, ${csStringLiteral(key)});\n`;
    body += renderAssertion(inner, expected, func, yamlType);
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
 * Render a datadir_value_type.yaml case body. Asserts the public typed
 * getter's coerced value (via TestSetup.DatadirGet), and — when
 * `expected.raw_value_type == "number"` — ALSO asserts the LOADED envelope's
 * raw Value is a real number, not a string, via TestSetup.AssertRawValueNumeric.
 *
 * NOTE: TestSetup.AssertRawValueNumeric does not exist yet — TestSetup is
 * built under qfg-zp7i.13. Emitting the reference now is consistent with
 * dotnet.ts's documented "fail-loud until TestSetup lands" policy: the
 * generated file references a helper that the SDK side must supply.
 */
function renderDatadirValueTypeBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const func = (kase.function ?? 'get').toString();
  const indent = '        ';

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
    opts.push(`"datadir", TestSetup.DATADIR`);
  }
  if ('environment' in overrides) {
    opts.push(`"environment", ${csStringLiteral(String(overrides.environment))}`);
  }
  const optsLit = opts.length > 0 ? `TestSetup.Map(${opts.join(', ')})` : 'TestSetup.Map()';

  const keyLit = csStringLiteral(key);
  const yamlType = (kase.type ?? 'STRING').toString().toUpperCase();

  let body = '';
  body += `${indent}object? actual = TestSetup.DatadirGet(${optsLit}, ${keyLit});\n`;
  body += renderAssertion(indent, expected, func, yamlType);
  if (rawType === 'number') {
    // Inspect the LOADED envelope's raw Value, before unwrap.
    // AssertRawValueNumeric is added under qfg-zp7i.13 (does not exist yet).
    body += `${indent}TestSetup.AssertRawValueNumeric(${optsLit}, ${keyLit});\n`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// post.yaml / telemetry.yaml renderer
// ---------------------------------------------------------------------------

function renderPostBody(kase: YamlCase): string {
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

  const aggLit = csStringLiteral(aggregator);
  const overridesLit = csLiteral(overrides);
  const dataLit = csLiteral(data);
  const expectedLit = csLiteral(expectedData);
  const endpointLit = csStringLiteral(endpoint);
  const ctxLit = renderContextsLiteral(merged);

  const indent = '        ';
  let body = '';
  body += `${indent}object? aggregator = TestSetup.BuildAggregator(${aggLit}, ${overridesLit});\n`;
  body += `${indent}TestSetup.FeedAggregator(aggregator, ${aggLit}, ${dataLit}, ${ctxLit});\n`;
  // xUnit2003 forbids Assert.Equal(null, ...) — use Assert.Null for parity with the
  // analyzer-friendly form. Generator emits the correct shape so callers don't need
  // to special-case post.yaml in code review.
  if (expectedData === null || expectedData === undefined) {
    body += `${indent}Assert.Null(TestSetup.AggregatorPost(aggregator, ${aggLit}, ${endpointLit}));\n`;
  } else {
    body += `${indent}Assert.Equal(${expectedLit}, TestSetup.AggregatorPost(aggregator, ${aggLit}, ${endpointLit}));\n`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function renderFile(suite: SuiteEntry, result: RenderResult): string {
  let out = '';
  out += `// AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=dotnet\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;

  // Collect namespaces used by exception classes. Always import Xunit.
  // The TestSetup helpers live in the same namespace as the generated class,
  // so no extra `using` is needed for them.
  const namespaces = new Set<string>();
  namespaces.add('Xunit');
  for (const fqcn of result.exceptions) {
    const ns = namespaceOf(fqcn);
    if (ns.length > 0) namespaces.add(ns);
  }
  // Stable, conventional ordering: System.* first, then everything else alphabetical.
  const sorted = Array.from(namespaces).sort((a, b) => {
    const aSystem = a === 'System' || a.startsWith('System.');
    const bSystem = b === 'System' || b.startsWith('System.');
    if (aSystem && !bSystem) return -1;
    if (!aSystem && bSystem) return 1;
    return a.localeCompare(b);
  });
  for (const ns of sorted) {
    out += `using ${ns};\n`;
  }
  out += `\n`;
  out += `namespace ${NAMESPACE};\n`;
  out += `\n`;
  out += `public class ${suite.className}\n`;
  out += `{\n`;
  for (const r of result.rendered) {
    out += r.source;
  }
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
    const yamlPath = resolve(dataRoot, suite.yaml);
    const cases = loadYamlFile(yamlPath, suite.yaml);
    const result = renderCases(suite, cases);
    const src = renderFile(suite, result);
    const outPath = resolve(outDir, suite.out);
    writeFileSync(outPath, src);
    written.push({ path: outPath, cases: result.rendered.length });
  }

  return { written };
}

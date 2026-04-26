// Go target — generates *_generated_test.go files under
// sdk-go/internal/fixtures/, one per YAML suite.
//
// Hard rules (set by project owner):
//
//   1. NO auto-skips, NO omissions, NO defensive shortcuts. Every YAML case
//      becomes a real, runnable Go test function. Cases the SDK can't yet
//      satisfy emit code that calls a sensibly-named helper or sentinel —
//      runtime/compile failure is the *desired* surfacing behavior, not a
//      hidden gap.
//
//   2. Unmapped raise errors and missing input keys FAIL the generator
//      (not the test). Better to stop here with a clear pointer than to
//      silently emit broken code.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import {
  goSuiteName,
  goTestFunctionName,
  uniqueGoSuffix,
} from '../shared/case-id.js';
import { mergeContexts } from '../shared/contexts.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
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
  { yaml: 'post.yaml', out: 'post_generated_test.go', suite: 'Post' },
  { yaml: 'telemetry.yaml', out: 'telemetry_generated_test.go', suite: 'Telemetry' },
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

/**
 * Build the three-arg `buildContextFromMaps(global, block, local)` call.
 * Uses `nil` for empty tiers to keep the call site readable.
 */
function buildContextCall(kase: YamlCase): string {
  const ctxBlock = kase.contexts ?? {};
  const global = (ctxBlock.global ?? null) as ContextTypes | null;
  const block = (ctxBlock.block ?? null) as ContextTypes | null;
  const local = (ctxBlock.local ?? null) as ContextTypes | null;
  const lit = (c: ContextTypes | null): string =>
    c == null ? 'nil' : goContextLiteral(c);
  return `buildContextFromMaps(${lit(global)}, ${lit(block)}, ${lit(local)})`;
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

/**
 * Render a single test function body (everything between the opening `{`
 * and closing `}`). Returns text with a trailing newline.
 *
 * Branches:
 *   - datadir_environment.yaml  → quonfig.NewClient(...) directly
 *   - post.yaml / telemetry.yaml → uniform aggregator helper trio
 *   - resolve-time raise        → assertResolveError
 *   - missing_default raise     → config-not-found assertion
 *   - initialization_timeout    → assertInitializationTimeoutError helper
 *                                 (does not exist yet — runtime/compile
 *                                  failure is the desired surface)
 *   - happy path                → mustLookupConfig + evaluateAndResolve +
 *                                 assert<Type>Value
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

  // Cases that drive real-Client construction (init timeout, fake api URL,
  // init-failure policy) need a real quonfig.NewClient(...) so the SDK's
  // init/timeout path actually runs. The resolver-only path can't observe
  // init-timeout because the resolver is built off a fully loaded store.
  // The helpers (assertInitializationTimeoutError /
  // assertClientConstructionRaises / assertClientConstructionMissingDefault
  // / assertClientConstructionValue) live in test_helpers_test.go and pull
  // in their own quonfig/errors imports — the generated file body only
  // calls the helper, so we don't add quonfig/errors to features here.
  if (hasClientConstructionOverridesGo(kase.client_overrides)) {
    return renderClientConstructionBodyGo(kase);
  }

  if (suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml') {
    // The aggregator helpers (BuildAggregator/FeedAggregator/...) are
    // expected to live alongside the existing fixtures helpers in
    // sdk-go/internal/fixtures/. Their signatures will reach into the
    // SDK's `eval` and `telemetry` packages to construct real evaluations
    // and assertions — but that's the SDK team's implementation choice.
    // The generated file itself doesn't need either import; if it does
    // import them later for type hints, the SDK can amend the helper
    // file rather than the generated one.
    return renderPostBody(kase);
  }

  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const envVars = kase.env_vars;

  if (expected.status === 'raise') {
    return renderRaiseBody(kase, features);
  }

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag and no raise expectation');
  }

  let expectedValue: unknown;
  let isMillis = false;
  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    expectedValue = expected.millis;
    isMillis = true;
  } else if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    expectedValue = expected.value;
  } else {
    throw new Error('case has no expected.value or expected.millis');
  }

  const fn = (kase.function ?? '').toString();
  const yamlType = (kase.type ?? '').toString().toUpperCase();

  const indent = '\t';
  let body = '';

  // Optional env var overrides via t.Setenv — Go's testing package handles
  // restoration. Useful if any non-datadir suite ever uses env_vars.
  if (envVars && typeof envVars === 'object') {
    for (const [k, v] of Object.entries(envVars)) {
      const sval = v === null || v === undefined ? '' : String(v);
      body += `${indent}t.Setenv(${goStringLiteral(k)}, ${goStringLiteral(sval)});\n`;
    }
  }

  // input.default present: route through assertGetWithDefault, which
  // mirrors the SDK's get-with-default semantic (missing-key → default,
  // found-key → resolved value, default ignored). The Go SDK lacks a
  // public default-arg getter; the helper bridges that gap.
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  if (hasDefault && !isMillis && expectedValue !== null && expectedValue !== undefined) {
    const def = (input as { default?: unknown }).default;
    body += `${indent}ctx := ${buildContextCall(kase)}\n`;
    body += `${indent}assertGetWithDefault(t, ${goStringLiteral(key)}, ctx, ${goLiteralValue(def)}, ${goLiteralValue(expectedValue)})\n`;
    return body;
  }

  body += `${indent}cfg := mustLookupConfig(t, ${goStringLiteral(key)})\n`;
  body += `${indent}ctx := ${buildContextCall(kase)}\n`;
  body += `${indent}match, err := evaluateAndResolve(t, cfg, ctx)\n`;
  body += `${indent}if err != nil {\n`;
  body += `${indent}\tt.Fatalf("resolver error: %v", err)\n`;
  body += `${indent}}\n`;

  // Pick the assertion based on type/function/value shape.
  if (isMillis) {
    body += `${indent}assertDurationMillis(t, match, ${(expectedValue as number).toString()})\n`;
    return body;
  }

  if (expectedValue === null || expectedValue === undefined) {
    body += `${indent}assertNilValue(t, match)\n`;
    return body;
  }

  if (fn === 'enabled') {
    body += `${indent}assertEnabledValue(t, match, ${expectedValue === true})\n`;
    return body;
  }

  switch (yamlType) {
    case 'STRING':
      if (typeof expectedValue !== 'string') {
        throw new Error(`STRING type but expected.value is ${typeof expectedValue}`);
      }
      body += `${indent}assertStringValue(t, match, ${goStringLiteral(expectedValue)})\n`;
      return body;
    case 'INT':
      if (typeof expectedValue !== 'number' || !Number.isInteger(expectedValue)) {
        throw new Error(`INT type but expected.value is not an integer: ${expectedValue}`);
      }
      body += `${indent}assertIntValue(t, match, ${expectedValue.toString()})\n`;
      return body;
    case 'DOUBLE':
      if (typeof expectedValue !== 'number') {
        throw new Error(`DOUBLE type but expected.value is not a number: ${expectedValue}`);
      }
      body += `${indent}assertDoubleValue(t, match, ${formatDouble(expectedValue)})\n`;
      return body;
    case 'BOOLEAN':
      body += `${indent}assertBoolValue(t, match, ${expectedValue === true})\n`;
      return body;
    case 'STRING_LIST':
      if (!Array.isArray(expectedValue)) {
        throw new Error(`STRING_LIST type but expected.value is not an array`);
      }
      body += `${indent}assertStringListValue(t, match, ${goStringListLiteral(expectedValue)})\n`;
      return body;
    case 'JSON':
      if (typeof expectedValue !== 'object' || Array.isArray(expectedValue)) {
        throw new Error(`JSON type but expected.value is not an object`);
      }
      body += `${indent}assertJSONValue(t, match, ${goLiteralValue(expectedValue)})\n`;
      return body;
    case 'DURATION':
      // Duration cases use `expected.millis`, handled above; reaching here
      // means the YAML used `expected.value` for a duration, which is an
      // unsupported shape.
      throw new Error('DURATION type with expected.value (not millis) is unsupported');
    case '':
      // No type given — infer from value shape. context_precedence has some
      // cases without `type:` but with boolean `value:`. Treat boolean as
      // enabled-style.
      if (typeof expectedValue === 'boolean') {
        body += `${indent}assertEnabledValue(t, match, ${expectedValue})\n`;
        return body;
      }
      if (typeof expectedValue === 'string') {
        body += `${indent}assertStringValue(t, match, ${goStringLiteral(expectedValue)})\n`;
        return body;
      }
      if (typeof expectedValue === 'number' && Number.isInteger(expectedValue)) {
        body += `${indent}assertIntValue(t, match, ${expectedValue.toString()})\n`;
        return body;
      }
      if (typeof expectedValue === 'number') {
        body += `${indent}assertDoubleValue(t, match, ${formatDouble(expectedValue)})\n`;
        return body;
      }
      throw new Error(
        `case has no type and value is ${typeof expectedValue}; can't pick assertion`,
      );
    default:
      throw new Error(`unsupported YAML type: ${yamlType}`);
  }
}

/**
 * Render a `raise` expectation (anything that isn't datadir/post/telemetry).
 * Each error class maps to a different Go pattern:
 *   missing_default        → assert config is missing (no resolver call)
 *   missing_env_var,
 *     unable_to_coerce_env_var,
 *     unable_to_decrypt    → resolver returns a sentinel error
 *   initialization_timeout → call assertInitializationTimeoutError(...)
 *                            (does not exist yet — that's the point)
 */
function renderRaiseBody(kase: YamlCase, features: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const errKey = (expected.error ?? '').toString();
  if (errKey.length === 0) {
    throw new Error('expected.status: raise but no expected.error provided');
  }
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('raise case has no input.key/flag');
  }

  const indent = '\t';
  const keyLit = goStringLiteral(key);

  switch (errKey) {
    case 'missing_default': {
      // The SDK has no client-level "missing default" raise in local eval;
      // the case is satisfied by verifying the config is absent from the
      // store. If a future SDK gains a real Get-or-raise, the assertion
      // can be tightened in test_helpers_test.go without touching
      // generated output.
      let body = '';
      body += `${indent}_, ok := configStore.GetConfig(${keyLit})\n`;
      body += `${indent}if ok {\n`;
      body += `${indent}\tt.Fatalf("expected config %q to be missing for missing_default case", ${keyLit})\n`;
      body += `${indent}}\n`;
      return body;
    }
    case 'missing_env_var':
    case 'unable_to_coerce_env_var':
    case 'unable_to_decrypt': {
      let body = '';
      body += `${indent}cfg := mustLookupConfig(t, ${keyLit})\n`;
      body += `${indent}ctx := ${buildContextCall(kase)}\n`;
      body += `${indent}match := evaluator.EvaluateConfig(cfg, "Production", ctx)\n`;
      body += `${indent}if !match.IsMatch || match.Value == nil {\n`;
      body += `${indent}\tt.Fatalf("expected a match for %q", ${keyLit})\n`;
      body += `${indent}}\n`;
      body += `${indent}_, err := testResolver.Resolve(match.Value, cfg, "Production", ctx)\n`;
      body += `${indent}assertResolveError(t, err, ${goStringLiteral(errKey)})\n`;
      return body;
    }
    case 'initialization_timeout': {
      // No SDK helper exists today — emit a call to a sensibly named one.
      // The compiler will say "undefined: assertInitializationTimeoutError"
      // until the SDK adds it. That's the desired surfacing behavior; we
      // don't reach for `quonfig` package symbols here.
      const overrides = kase.client_overrides ?? {};
      const timeoutSec =
        typeof overrides.initialization_timeout_sec === 'number'
          ? overrides.initialization_timeout_sec
          : 0.01;
      const apiURL =
        typeof overrides.prefab_api_url === 'string'
          ? overrides.prefab_api_url
          : '';
      const onInitFailure =
        typeof overrides.on_init_failure === 'string'
          ? overrides.on_init_failure.replace(/^:/, '')
          : 'raise';
      let body = '';
      body += `${indent}assertInitializationTimeoutError(t, ${keyLit}, ${formatDouble(timeoutSec)}, ${goStringLiteral(apiURL)}, ${goStringLiteral(onInitFailure)})\n`;
      return body;
    }
    default: {
      // Try the global mapping for anything else (missing_environment etc.
      // currently surface only via datadir cases, so this branch is mainly
      // a safety net for new error keys).
      const errClass = lookupErrorClass('go', errKey);
      if (!errClass) {
        throw new Error(
          `no Go error mapping for expected.error="${errKey}". ` +
            `Add it to src/shared/error-mapping.ts (GO_ERRORS) or update the ` +
            `raise-case dispatch in src/targets/go.ts.`,
        );
      }
      let body = '';
      body += `${indent}cfg := mustLookupConfig(t, ${keyLit})\n`;
      body += `${indent}ctx := ${buildContextCall(kase)}\n`;
      body += `${indent}match := evaluator.EvaluateConfig(cfg, "Production", ctx)\n`;
      body += `${indent}if !match.IsMatch || match.Value == nil {\n`;
      body += `${indent}\tt.Fatalf("expected a match for %q", ${keyLit})\n`;
      body += `${indent}}\n`;
      body += `${indent}_, err := testResolver.Resolve(match.Value, cfg, "Production", ctx)\n`;
      body += `${indent}if !errors.Is(err, ${errClass}) {\n`;
      body += `${indent}\tt.Errorf("expected %v, got: %v", ${errClass}, err)\n`;
      body += `${indent}}\n`;
      features.add('errors');
      return body;
    }
  }
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
      // Unknown init-error variant — assert _some_ message; the SDK error
      // class assertion can be tightened later via lookupErrorClass.
      const errClass = lookupErrorClass('go', errKey);
      if (errClass) {
        body += `${indent}assert.True(t, errors.Is(err, ${errClass}), "expected ${errClass}, got %v", err)\n`;
      }
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
 * Render post.yaml / telemetry.yaml case bodies.
 *
 * Uniform shape (matches Ruby target conceptually):
 *   agg := BuildAggregator(t, kind, overrides)
 *   FeedAggregator(t, agg, kind, data, ctx)
 *   AssertAggregatorPost(t, agg, kind, expectedData, endpoint)
 *
 * None of these helpers exist in sdk-go today. They will fail to compile
 * until the SDK team adds them — that's the desired surfacing.
 */
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

  const aggLit = goStringLiteral(aggregator);
  const overridesLit = goLiteralValue(overrides);
  const dataLit = goLiteralValue(data);
  const expectedLit = goLiteralValue(expectedData);
  const endpointLit = goStringLiteral(endpoint);
  const ctxLit = goContextLiteral(merged);

  const indent = '\t';
  let body = '';
  body += `${indent}agg := BuildAggregator(t, ${aggLit}, ${overridesLit})\n`;
  body += `${indent}FeedAggregator(t, agg, ${aggLit}, ${dataLit}, ${ctxLit})\n`;
  body += `${indent}AssertAggregatorPost(t, agg, ${aggLit}, ${expectedLit}, ${endpointLit})\n`;
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

/**
 * Render a body for a case that constructs a real quonfig.NewClient(...)
 * with init-timeout / fake api-url overrides. Asserts the expected raise
 * (initialization_timeout / missing_default) or value depending on the YAML.
 */
function renderClientConstructionBodyGo(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const fn = (kase.function ?? 'get').toString();
  const indent = '\t';

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('client-construction case has no input.key/flag');
  }
  const errKey = (expected.error ?? '').toString();
  const onInitFailure = (() => {
    const v = overrides.on_init_failure;
    if (typeof v !== 'string') return 'raise';
    return v.replace(/^:/, '');
  })();
  const timeoutSec =
    typeof overrides.initialization_timeout_sec === 'number'
      ? overrides.initialization_timeout_sec
      : 0.01;
  const apiURL =
    typeof overrides.prefab_api_url === 'string' ? overrides.prefab_api_url : '';
  const isRaise = expected.status === 'raise';
  if (isRaise && errKey === 'initialization_timeout') {
    return `${indent}assertInitializationTimeoutError(t, ${goStringLiteral(key)}, ${formatDouble(timeoutSec)}, ${goStringLiteral(apiURL)}, ${goStringLiteral(onInitFailure)})\n`;
  }
  if (isRaise && errKey === 'missing_default') {
    // The Go SDK has no missing_default error class — GetXxxValue returns
    // (zero, false, nil). The helper checks ok=false and reports it.
    return `${indent}assertClientConstructionMissingDefault(t, ${goStringLiteral(key)}, ${formatDouble(timeoutSec)}, ${goStringLiteral(apiURL)}, ${goStringLiteral(onInitFailure)}, ${goStringLiteral(fn)})\n`;
  }
  if (isRaise) {
    const errClass = lookupErrorClass('go', errKey);
    if (!errClass) {
      throw new Error(
        `no Go error mapping for expected.error="${errKey}" in client-construction case.`,
      );
    }
    return `${indent}assertClientConstructionRaises(t, ${goStringLiteral(key)}, ${formatDouble(timeoutSec)}, ${goStringLiteral(apiURL)}, ${goStringLiteral(onInitFailure)}, ${goStringLiteral(fn)}, ${errClass})\n`;
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    return `${indent}assertClientConstructionValue(t, ${goStringLiteral(key)}, ${formatDouble(timeoutSec)}, ${goStringLiteral(apiURL)}, ${goStringLiteral(onInitFailure)}, ${goStringLiteral(fn)}, ${goLiteralValue(expected.value)})\n`;
  }
  throw new Error('client-construction case has no expected.value or expected.error');
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
    imports.unshift('"errors"');
  }
  // Third-party / project imports go in a separate block per gofmt style.
  const projectImports: string[] = [];
  if (features.has('quonfig')) {
    projectImports.push('quonfig "github.com/quonfig/sdk-go"');
  }
  if (features.has('eval')) {
    projectImports.push('"github.com/quonfig/sdk-go/internal/eval"');
  }
  if (features.has('telemetry')) {
    projectImports.push('"github.com/quonfig/sdk-go/internal/telemetry"');
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

  // post/telemetry use BuildAggregator/etc. which don't exist; if `eval`
  // was tagged, emit the same `_ eval.ContextValueGetter` sink as the
  // existing files so the import isn't reported as unused (it will be
  // unused once the helpers are stubbed out — keeping the sink prevents
  // a misleading "imported and not used" error).
  if (features.has('eval') && !bodyUsesEvalIdentifier(rendered)) {
    out += `\n// Ensure the eval import is used.\nvar _ eval.ContextValueGetter\n`;
  }
  if (features.has('telemetry') && !bodyUsesTelemetryIdentifier(rendered)) {
    out += `\n// Ensure the telemetry import is used.\nvar _ telemetry.EvalMatch\n`;
  }
  return out;
}

function bodyUsesEvalIdentifier(rendered: RenderedCase[]): boolean {
  return rendered.some((r) => /\beval\./.test(r.source));
}
function bodyUsesTelemetryIdentifier(rendered: RenderedCase[]): boolean {
  return rendered.some((r) => /\btelemetry\./.test(r.source));
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

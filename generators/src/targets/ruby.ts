// Ruby target — generates Minitest files under sdk-ruby/test/integration/.
//
// Ports the previous Ruby-in-Ruby generator (sdk-ruby/scripts/generate_integration_tests.rb)
// with two important behavioral changes:
//
//   1. NO auto-skips, no omissions, no wrap-and-rescue. Every YAML case
//      becomes a runnable test method. Cases whose YAML shape doesn't have
//      a matching helper today (post.yaml / telemetry.yaml — aggregator /
//      data / expected_data) are still emitted, calling consistently named
//      helper methods that may not yet exist. At runtime those raise
//      NoMethodError, which is the *desired* outcome — it surfaces the gap
//      rather than hiding it.
//
//   2. Unmapped raise errors and missing input keys FAIL the generator
//      (rather than silently skipping the case at runtime).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import { rubyMethodSuffix, uniqueSuffix } from '../shared/case-id.js';
import { mergeContexts } from '../shared/contexts.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
import type { NormalizedCase, YamlCase } from '../types.js';

interface SuiteEntry {
  yaml: string;
  out: string;
  className: string;
}

const SUITES: SuiteEntry[] = [
  { yaml: 'get.yaml', out: 'test_get.rb', className: 'TestGet' },
  { yaml: 'enabled.yaml', out: 'test_enabled.rb', className: 'TestEnabled' },
  { yaml: 'get_or_raise.yaml', out: 'test_get_or_raise.rb', className: 'TestGetOrRaise' },
  { yaml: 'get_feature_flag.yaml', out: 'test_get_feature_flag.rb', className: 'TestGetFeatureFlag' },
  { yaml: 'get_weighted_values.yaml', out: 'test_get_weighted_values.rb', className: 'TestGetWeightedValues' },
  { yaml: 'context_precedence.yaml', out: 'test_context_precedence.rb', className: 'TestContextPrecedence' },
  { yaml: 'enabled_with_contexts.yaml', out: 'test_enabled_with_contexts.rb', className: 'TestEnabledWithContexts' },
  { yaml: 'datadir_environment.yaml', out: 'test_datadir_environment.rb', className: 'TestDatadirEnvironment' },
  { yaml: 'datadir_value_type.yaml', out: 'test_datadir_value_type.rb', className: 'TestDatadirValueType' },
  { yaml: 'delivery_environment.yaml', out: 'test_delivery_environment.rb', className: 'TestDeliveryEnvironment' },
  { yaml: 'post.yaml', out: 'test_post.rb', className: 'TestPost' },
  { yaml: 'telemetry.yaml', out: 'test_telemetry.rb', className: 'TestTelemetry' },
  { yaml: 'dev_overrides.yaml', out: 'test_dev_overrides.rb', className: 'TestDevOverrides' },
];

const GENERATOR_PATH = 'integration-test-data/generators/src/targets/ruby.ts';

/**
 * Format an arbitrary JS value as a Ruby literal. Produces the same shapes the
 * Ruby reference implementation produced via `Object#inspect`/`Hash#inspect`,
 * so generated assertions stay byte-comparable to the prior output.
 */
export function rubyLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return formatRubyInt(value);
    return value.toString();
  }
  if (typeof value === 'string') return rubyStringLiteral(value);
  if (Array.isArray(value)) {
    // Style/WordArray: arrays of bare-word strings (alphanumerics +
    // underscore + a couple of common punctuation chars rubocop tolerates)
    // render as `%w[a b c]` rather than `['a', 'b', 'c']`. Default
    // MinSize is 2; only kick in at length >= 2.
    if (value.length >= 2 && value.every(isWordArrayElement)) {
      return '%w[' + (value as string[]).join(' ') + ']';
    }
    return '[' + value.map(rubyLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${rubyLiteral(k)} => ${rubyLiteral(v)}`,
    );
    if (entries.length === 0) return '{}';
    // Layout/SpaceInsideHashLiteralBraces: `{ a => b }` not `{a => b}`.
    return '{ ' + entries.join(', ') + ' }';
  }
  // Fallback — shouldn't hit for the YAML shapes we use.
  return rubyStringLiteral(String(value));
}

/**
 * True when a string is a candidate for `%w[]` array notation — i.e.
 * matches rubocop's default Style/WordArray WordRegex of `\A[\p{Word}]+\z`
 * (letters, digits, underscore). We deliberately exclude whitespace,
 * dots, dashes, and punctuation so the output stays unambiguous.
 */
function isWordArrayElement(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (v.length === 0) return false;
  return /^[A-Za-z0-9_]+$/.test(v);
}

/**
 * Render a Ruby integer with underscores every three digits when the
 * magnitude is large enough to trigger Style/NumericLiterals (default
 * MinDigits: 5).
 */
function formatRubyInt(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toString();
  if (abs.length < 5) return sign + abs;
  // Insert `_` every 3 digits from the right.
  let out = '';
  for (let i = 0; i < abs.length; i++) {
    if (i > 0 && (abs.length - i) % 3 === 0) out += '_';
    out += abs[i];
  }
  return sign + out;
}

/**
 * Render a Ruby string literal. Prefers single quotes (Style/StringLiterals
 * default) when the string is safe for them — i.e. has no escape sequences
 * that single-quoted strings can't represent (control chars, embedded `'`
 * or `\`). Falls back to double-quoted with the usual `\n`/`\t`/`\xNN`
 * escapes when needed.
 */
function rubyStringLiteral(s: string): string {
  // Single-quoted strings only need to escape `\` and `'`. They cannot
  // represent `\n`, `\t`, `\r`, or other control chars without losing
  // their literal meaning, so fall back to double-quoted in that case.
  let needsDouble = false;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      needsDouble = true;
      break;
    }
  }
  if (!needsDouble) {
    let out = "'";
    for (const ch of s) {
      if (ch === '\\' || ch === "'") {
        out += '\\' + ch;
      } else {
        out += ch;
      }
    }
    out += "'";
    return out;
  }

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

interface RenderedCase {
  source: string; // full `def test_xxx ... end\n` block, indented two spaces
}

interface RenderResult {
  rendered: RenderedCase[];
}

/**
 * Render a single suite's cases into Ruby method bodies.
 * Throws for cases that the user has explicitly told us must fail-loud
 * (unmapped raise errors etc). Every YAML case produces one method —
 * no omissions, no skips.
 */
function renderCases(yamlBasename: string, cases: NormalizedCase[]): RenderResult {
  const rendered: RenderedCase[] = [];
  const seen = new Map<string, number>();

  for (const nc of cases) {
    const kase = nc.raw;
    const rawName = (kase.name ?? '').toString();
    const baseSuffix = rubyMethodSuffix(rawName);
    const suffix = uniqueSuffix(seen, baseSuffix);

    let body: string;
    try {
      body = renderBody(yamlBasename, kase);
    } catch (e) {
      // Generator-fatal — bubble up so the CLI can stop with a clear pointer.
      throw new GeneratorError(
        `[${yamlBasename}] case "${rawName}": ${(e as Error).message}`,
      );
    }

    const block =
      `\n  # ${rawName}\n` +
      `  def test_${suffix}\n` +
      body +
      `  end\n`;
    rendered.push({ source: block });
  }

  return { rendered };
}

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
}

/**
 * Render the body of a single test method (everything between the
 * `def test_*` line and the matching `end`). Always returns a string with
 * a trailing newline; callers concatenate. The 4-space lead matches the
 * Ruby reference output.
 */
function renderBody(yamlBasename: string, kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const merged = mergeContexts(kase.contexts);
  const envVars = kase.env_vars;

  // datadir suite drives `Quonfig::Client.new(...)` directly.
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

  // Cases that override real-client-construction params (init timeout, fake
  // api URL, init-failure policy) need a real Quonfig::Client.new(...) so the
  // SDK's init/timeout/error path actually runs. The resolver-only path
  // can't observe init-timeout because the resolver is built off a fully
  // loaded store. Mirror the datadir suite shape.
  if (hasClientConstructionOverrides(kase.client_overrides)) {
    return renderClientConstructionBody(kase);
  }

  // post.yaml / telemetry.yaml — aggregator / data / expected_data shape.
  // Every case becomes a real test method calling consistent helpers
  // (build_aggregator / feed_aggregator / assert_aggregator_post). Some
  // helpers don't exist in IntegrationTestHelpers yet; that's intentional —
  // they fail at runtime with NoMethodError, which surfaces the gap to
  // the SDK team rather than silently omitting the case.
  if (yamlBasename === 'post.yaml' || yamlBasename === 'telemetry.yaml') {
    return renderPostBody(kase);
  }

  // raise expectation
  if (expected.status === 'raise') {
    const errKey = expected.error;
    if (typeof errKey !== 'string' || errKey.length === 0) {
      throw new Error(`expected.status: raise but no expected.error provided`);
    }
    const errClass = lookupErrorClass('ruby', errKey);
    if (!errClass) {
      throw new Error(
        `no Quonfig::Errors mapping for expected.error="${errKey}". ` +
          `Add it to src/shared/error-mapping.ts (RUBY_ERRORS) or remove the case from YAML.`,
      );
    }

    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('raise case has no input.key/flag');
    }

    const ctxLit = rubyLiteral(merged);
    const keyLit = rubyLiteral(key);
    let body = '';
    body += `    resolver = IntegrationTestHelpers.build_resolver(@store)\n`;
    body += `    ctx = Quonfig::Context.new(${ctxLit})\n`;
    if (envVars && typeof envVars === 'object') {
      body += `    IntegrationTestHelpers.with_env(${rubyLiteral(stringifyEnvVars(envVars))}) do\n`;
      body += `      assert_raises(${errClass}) { resolver.get(${keyLit}, ctx) }\n`;
      body += `    end\n`;
    } else {
      body += `    assert_raises(${errClass}) { resolver.get(${keyLit}, ctx) }\n`;
    }
    return body;
  }

  // Happy path / non-raise expectation
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag and no raise expectation');
  }

  let expectedValue: unknown;
  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    expectedValue = expected.millis;
  } else if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    expectedValue = expected.value;
  } else {
    throw new Error('case has no expected.value or expected.millis');
  }

  const ctxLit = rubyLiteral(merged);
  const expLit = rubyLiteral(expectedValue);
  const keyLit = rubyLiteral(key);
  const fn = (kase.function ?? '').toString();
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  const def = (input as { default?: unknown }).default;

  // The `assert_get_with_default` branch takes `@store` directly and never
  // touches `resolver`, so building one would trip Lint/UselessAssignment.
  // Only emit the resolver setup line for branches that actually use it.
  const needsResolver = fn === 'enabled' || !hasDefault;

  let inner = '';
  if (needsResolver) {
    inner += `    resolver = IntegrationTestHelpers.build_resolver(@store)\n`;
  }
  const envWrap = envVars && typeof envVars === 'object';
  if (envWrap) {
    inner += `    IntegrationTestHelpers.with_env(${rubyLiteral(stringifyEnvVars(envVars))}) do\n`;
  }
  const indent = envWrap ? '      ' : '    ';

  if (fn === 'enabled') {
    // function: enabled — coerce non-bool to false. Use a dedicated helper
    // so the bool-coercion semantics live in the helper, not inferred from
    // the expected literal.
    inner += `${indent}IntegrationTestHelpers.assert_enabled(self, resolver, ${keyLit}, ${ctxLit}, ${expLit})\n`;
  } else if (hasDefault) {
    // input.default: thread through the SDK's get-with-default API. Build
    // a real client over the loaded store so we observe what the SDK
    // actually returns, not what a stubbed test helper returns.
    inner += `${indent}IntegrationTestHelpers.assert_get_with_default(self, @store, ${keyLit}, ${ctxLit}, ${rubyLiteral(def)}, ${expLit})\n`;
  } else {
    inner += `${indent}IntegrationTestHelpers.assert_resolved(self, resolver, ${keyLit}, ${ctxLit}, ${expLit})\n`;
  }
  if (envWrap) {
    inner += `    end\n`;
  }
  return inner;
}

/** True iff client_overrides contains keys that drive Client construction. */
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
 * Render a body for a case that constructs a real Quonfig::Client (init
 * timeout, fake api url, init-failure policy). Supports both the raise path
 * (init timeout fires) and the recover path (on_init_failure: :return).
 */
function renderClientConstructionBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const fn = (kase.function ?? 'get').toString();
  const indent = '    ';

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('client-construction case has no input.key/flag');
  }
  const keyLit = rubyLiteral(key);

  const errKey = (expected.error ?? '').toString();
  const onInitFailure = (() => {
    const v = overrides.on_init_failure;
    if (typeof v !== 'string') return 'raise';
    return v.replace(/^:/, '');
  })();
  const timeout =
    typeof overrides.initialization_timeout_sec === 'number'
      ? overrides.initialization_timeout_sec
      : 0.01;
  const apiURL =
    typeof overrides.prefab_api_url === 'string' ? overrides.prefab_api_url : '';

  const isRaise = expected.status === 'raise';
  if (isRaise && errKey === 'initialization_timeout') {
    return (
      `${indent}IntegrationTestHelpers.assert_initialization_timeout_error(self, ${keyLit}, ${timeout}, ${rubyLiteral(apiURL)}, ${rubyLiteral(onInitFailure)})\n`
    );
  }
  if (isRaise) {
    // Other raise types via real-client path (e.g. missing_default with
    // init returning zero value, then get_or_raise still raising).
    const errClass = lookupErrorClass('ruby', errKey);
    if (!errClass) {
      throw new Error(
        `no Quonfig::Errors mapping for expected.error="${errKey}" in client-construction case.`,
      );
    }
    return (
      `${indent}IntegrationTestHelpers.assert_client_construction_raises(self, ${keyLit}, ${timeout}, ${rubyLiteral(apiURL)}, ${rubyLiteral(onInitFailure)}, ${rubyLiteral(fn)}, ${errClass})\n`
    );
  }
  // Happy path through real-client construction is rare; fall back to
  // resolver-style assert if expected.value is set.
  if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    return (
      `${indent}IntegrationTestHelpers.assert_client_construction_value(self, ${keyLit}, ${timeout}, ${rubyLiteral(apiURL)}, ${rubyLiteral(onInitFailure)}, ${rubyLiteral(fn)}, ${rubyLiteral(expected.value)})\n`
    );
  }
  throw new Error('client-construction case has no expected.value or expected.error');
}

/**
 * Render a datadir_environment.yaml case body. Builds a Quonfig::Client
 * directly with `datadir:` + `environment:` overrides, then exercises it
 * (or asserts init raises). No rescue wrapper — failures surface.
 */
function renderDatadirBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars;
  const func = (kase.function ?? 'get').toString();

  const opts: string[] = [];
  if ('datadir' in overrides) {
    opts.push('datadir: IntegrationTestHelpers.data_dir');
  }
  if ('environment' in overrides) {
    opts.push(`environment: ${rubyLiteral(overrides.environment)}`);
  }
  const optsLit = opts.join(', ');

  const useEnv = envVars && typeof envVars === 'object';
  const indent = useEnv ? '      ' : '    ';

  let body = '';
  if (useEnv) {
    body += `    IntegrationTestHelpers.with_env(${rubyLiteral(stringifyEnvVars(envVars))}) do\n`;
  }

  if (func === 'init' && expected.status === 'raise') {
    const errKey = expected.error;
    if (typeof errKey !== 'string' || errKey.length === 0) {
      throw new Error('init raise case missing expected.error');
    }
    const errClass = lookupErrorClass('ruby', errKey);
    if (!errClass) {
      throw new Error(
        `no Quonfig::Errors mapping for expected.error="${errKey}" in datadir init case. ` +
          `Add it to src/shared/error-mapping.ts (RUBY_ERRORS).`,
      );
    }
    body += `${indent}assert_raises(${errClass}) { Quonfig::Client.new(${optsLit}) }\n`;
  } else {
    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('datadir get-case has no input.key/flag');
    }
    if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
      throw new Error('datadir get-case has no expected.value');
    }
    body += `${indent}client = Quonfig::Client.new(${optsLit})\n`;
    body += `${indent}assert_equal ${rubyLiteral(expected.value)}, client.get(${rubyLiteral(key)})\n`;
  }

  if (useEnv) {
    body += `    end\n`;
  }
  return body;
}

/**
 * Render a datadir_value_type.yaml case body. Builds a real datadir-mode
 * Quonfig::Client, asserts the public getter's coerced value, and — when
 * `expected.raw_value_type == "number"` — ALSO asserts the LOADED envelope's
 * raw Value is a Numeric, not a String. `client.store` is a public
 * attr_reader; `store.get(key)` returns the raw ConfigResponse hash, whose
 * raw Value for a simple single-rule ALWAYS_TRUE config lives at
 * `['default']['rules'][0]['value']['value']`. A datadir loader that left
 * int/double as on-disk strings fails the `is_a?(Numeric)` assertion.
 */
function renderDatadirValueTypeBody(kase: YamlCase): string {
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

  const opts: string[] = [];
  if ('datadir' in overrides) {
    opts.push('datadir: IntegrationTestHelpers.data_dir');
  }
  if ('environment' in overrides) {
    opts.push(`environment: ${rubyLiteral(overrides.environment)}`);
  }
  const optsLit = opts.join(', ');

  const keyLit = rubyLiteral(key);
  const indent = '    ';

  let body = '';
  body += `${indent}client = Quonfig::Client.new(${optsLit})\n`;
  body += `${indent}assert_equal ${rubyLiteral(expected.value)}, client.get(${keyLit})\n`;
  if (rawType === 'number') {
    body += `${indent}raw_config = client.store.get(${keyLit})\n`;
    body += `${indent}refute_nil raw_config, ${rubyLiteral(`store.get(${key}) should be loaded`)}\n`;
    body += `${indent}raw_value = raw_config['default']['rules'][0]['value']['value']\n`;
    body += `${indent}assert_kind_of Numeric, raw_value,\n`;
    body += `${indent}               "datadir loader must coerce ${key} to a number, got #{raw_value.class} (#{raw_value.inspect})"\n`;
  }
  return body;
}

/**
 * Render a post.yaml / telemetry.yaml case body.
 *
 * Every such case has:
 *   aggregator:    one of context_shape | evaluation_summary | example_contexts
 *   endpoint:      "/api/v1/context-shapes" | "/api/v1/telemetry"
 *   data:          aggregator input — either keys array, single context hash,
 *                  or array of context hashes (depends on aggregator)
 *   expected_data: aggregator output to assert against (may be nil/empty)
 *   contexts:      optional context block (merged via mergeContexts)
 *   client_overrides: optional config flags (e.g. context_upload_mode)
 *
 * Generated Ruby invokes a small uniform helper API:
 *   IntegrationTestHelpers.build_aggregator(type, overrides_hash)
 *   IntegrationTestHelpers.feed_aggregator(agg, type, data, contexts: ctx)
 *   IntegrationTestHelpers.assert_aggregator_post(self, agg, type, expected, endpoint:)
 *
 * Some of those helpers may not exist on IntegrationTestHelpers yet. That's
 * fine — at runtime they raise NoMethodError, which surfaces the missing
 * helper to whoever is implementing the SDK side. Hiding the case via a
 * generator-side omission is strictly worse.
 */
/**
 * Render a delivery_environment.yaml case body. Cross-SDK DELIVERY-WIRE-SHAPE
 * gate (qfg-xpln): stands up a WEBrick server returning the literal `envelope`
 * JSON on /api/v2/configs (the shape api-delivery emits in SDK-key mode),
 * builds a real Quonfig::Client in SDK-key mode (NO environment pin unless
 * client_overrides.environment is set), then asserts the resolved boolean.
 * Exercises the wire parse + meta.environment selection path the datadir tests
 * never touch. Modeled on the hand-written test_client_network_mode.rb.
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

  const kwargs: string[] = [
    `sdk_key: ${rubyStringLiteral(sdkKey)}`,
    `api_urls: ["http://127.0.0.1:#{port}"]`,
    `enable_sse: false`,
    `enable_polling: false`,
    `context_upload_mode: :none`,
    `collect_evaluation_summaries: false`,
  ];
  if ('environment' in overrides) {
    kwargs.push(`environment: ${rubyStringLiteral(String(overrides.environment))}`);
  }

  let body = '';
  body += `${indent}prev_env = ENV.delete('QUONFIG_ENVIRONMENT')\n`;
  body += `${indent}envelope_json = ${rubyStringLiteral(envelopeJson)}\n`;
  body += `${indent}server, port = start_delivery_server(envelope_json)\n`;
  body += `${indent}client = Quonfig::Client.new(\n`;
  body += kwargs.map((kw) => `${indent}  ${kw}`).join(',\n') + '\n';
  body += `${indent})\n`;
  body += `${indent}assert_equal ${expVal ? 'true' : 'false'}, client.get(${rubyStringLiteral(key)}, :missing),\n`;
  body += `${indent}             ${rubyStringLiteral(`delivery-wire env override: expected ${expVal} for ${key}`)}\n`;
  body += `${indent}ensure\n`;
  body += `${indent}  client&.stop\n`;
  body += `${indent}  server&.shutdown\n`;
  body += `${indent}  ENV['QUONFIG_ENVIRONMENT'] = prev_env if prev_env\n`;
  return body;
}

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

  const aggLit = ':' + aggregator;
  const overridesLit = rubyLiteral(overrides);
  const dataLit = rubyLiteral(data);
  const expectedLit = rubyLiteral(expectedData);
  const endpointLit = rubyLiteral(endpoint);
  const ctxLit = rubyLiteral(merged);

  let body = '';
  body += `    aggregator = IntegrationTestHelpers.build_aggregator(${aggLit}, ${overridesLit})\n`;
  body += `    IntegrationTestHelpers.feed_aggregator(aggregator, ${aggLit}, ${dataLit}, contexts: ${ctxLit})\n`;
  body += `    IntegrationTestHelpers.assert_aggregator_post(self, aggregator, ${aggLit}, ${expectedLit}, endpoint: ${endpointLit})\n`;
  return body;
}

function stringifyEnvVars(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[String(k)] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

function renderDeliveryFile(suite: SuiteEntry, rendered: RenderedCase[]): string {
  let out = '';
  out += `# frozen_string_literal: true\n`;
  out += `\n`;
  out += `# AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}.\n`;
  out += `# Regenerate with:\n`;
  out += `#   cd integration-test-data/generators && npm run generate -- --target=ruby\n`;
  out += `# Source: ${GENERATOR_PATH}\n`;
  out += `# Do NOT edit by hand — changes will be overwritten.\n`;
  out += `\n`;
  out += `require 'test_helper'\n`;
  out += `require 'webrick'\n`;
  out += `require 'json'\n`;
  out += `require 'socket'\n`;
  out += `\n`;
  out += `class ${suite.className} < Minitest::Test\n`;
  out += `  # Stand up a WEBrick server returning the literal wire envelope on\n`;
  out += `  # /api/v2/configs (the shape api-delivery emits in SDK-key mode).\n`;
  out += `  def start_delivery_server(envelope_json)\n`;
  out += `    log = WEBrick::Log.new(StringIO.new)\n`;
  out += `    server = WEBrick::HTTPServer.new(Port: 0, Logger: log, AccessLog: [])\n`;
  out += `    server.mount_proc '/api/v2/configs' do |_req, res|\n`;
  out += `      res.status = 200\n`;
  out += `      res['Content-Type'] = 'application/json'\n`;
  out += `      res['ETag'] = '"v1"'\n`;
  out += `      res.body = envelope_json\n`;
  out += `    end\n`;
  out += `    port = server.config[:Port]\n`;
  out += `    Thread.new { server.start }\n`;
  out += `    50.times do\n`;
  out += `      break if tcp_open?(port)\n`;
  out += `\n`;
  out += `      sleep 0.05\n`;
  out += `    end\n`;
  out += `    [server, port]\n`;
  out += `  end\n`;
  out += `\n`;
  out += `  def tcp_open?(port)\n`;
  out += `    TCPSocket.new('127.0.0.1', port).tap(&:close)\n`;
  out += `    true\n`;
  out += `  rescue StandardError\n`;
  out += `    false\n`;
  out += `  end\n`;
  for (const r of rendered) {
    out += r.source;
  }
  out += `end\n`;
  return out;
}

function renderFile(suite: SuiteEntry, rendered: RenderedCase[]): string {
  if (suite.yaml === 'delivery_environment.yaml') {
    return renderDeliveryFile(suite, rendered);
  }
  let out = '';
  out += `# frozen_string_literal: true\n`;
  // Layout/EmptyLineAfterMagicComment requires a blank line between the
  // magic comment and the next non-comment block.
  out += `\n`;
  out += `# AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}.\n`;
  out += `# Regenerate with:\n`;
  out += `#   cd integration-test-data/generators && npm run generate -- --target=ruby\n`;
  out += `# Source: ${GENERATOR_PATH}\n`;
  out += `# Do NOT edit by hand — changes will be overwritten.\n`;
  out += `\n`;
  out += `require 'test_helper'\n`;
  out += `require 'integration/test_helpers'\n`;
  out += `\n`;
  out += `class ${suite.className} < Minitest::Test\n`;
  out += `  def setup\n`;
  out += `    @store = IntegrationTestHelpers.build_store(${rubyLiteral(stripExt(suite.yaml))})\n`;
  out += `  end\n`;
  for (const r of rendered) {
    out += r.source;
  }
  out += `end\n`;
  return out;
}

function stripExt(name: string): string {
  return name.endsWith('.yaml') ? name.slice(0, -'.yaml'.length) : name;
}

export interface RubyRunResult {
  written: { path: string; cases: number }[];
}

/**
 * Entry point used by src/index.ts.
 *
 * @param dataRoot integration-test-data/tests/eval (absolute)
 * @param outDir   sdk-ruby/test/integration         (absolute)
 */
export function runRubyTarget(dataRoot: string, outDir: string): RubyRunResult {
  mkdirSync(outDir, { recursive: true });
  const written: RubyRunResult['written'] = [];

  for (const suite of SUITES) {
    const yamlPath = resolve(dataRoot, suite.yaml);
    const cases = loadYamlFile(yamlPath, suite.yaml);
    const { rendered } = renderCases(suite.yaml, cases);
    const src = renderFile(suite, rendered);
    const outPath = resolve(outDir, suite.out);
    writeFileSync(outPath, src);
    written.push({ path: outPath, cases: rendered.length });
  }

  return { written };
}

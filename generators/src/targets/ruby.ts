// Ruby target — generates Minitest files under sdk-ruby/test/integration/.
//
// Rules:
//
//   1. NO auto-skips, no omissions, no wrap-and-rescue. Every YAML case
//      becomes a runnable test method.
//
//   2. Unmapped raise errors, unknown types/functions and missing input keys
//      FAIL the generator (rather than silently skipping the case at runtime).
//
//   3. PUBLIC API only (qfg-2agi.33). Every case drives Quonfig::Client the way
//      a customer does: a datadir client over the shared corpus; the typed
//      getter named by the YAML `type:` (get_string / get_int / get_float /
//      get_bool / get_string_list / get_json / get_duration), `enabled?`, or
//      `get_or_raise`; context tiers through global_context: /
//      with_context / in_context (the SDK merges them, the generator does
//      not); telemetry through the client's real reporter flushed to a local
//      HTTP sink. No Resolver calls, no harness-side exception mapping, no
//      harness-side redaction.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import { rubyMethodSuffix, uniqueSuffix } from '../shared/case-id.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
import { repeatSpec, repeatValueType } from '../shared/repeat.js';
import type { ContextTypes, NormalizedCase, YamlCase } from '../types.js';

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
 * YAML `type:` -> the PUBLIC typed getter on Quonfig::Client / BoundClient.
 * An unknown type is a generator error, never a silent fallback to `get`.
 */
const TYPED_GETTERS: Record<string, string> = {
  STRING: 'get_string',
  INT: 'get_int',
  DOUBLE: 'get_float',
  BOOL: 'get_bool',
  BOOLEAN: 'get_bool',
  STRING_LIST: 'get_string_list',
  JSON: 'get_json',
  DURATION: 'get_duration',
};

function typedGetter(kase: YamlCase): string {
  const t = (kase.type ?? '').toString().toUpperCase();
  const m = TYPED_GETTERS[t];
  if (!m) {
    throw new Error(`no Ruby typed getter for type ${JSON.stringify(kase.type)} (function ${kase.function ?? 'get'})`);
  }
  return m;
}

function caseKey(kase: YamlCase): string {
  const input = kase.input ?? {};
  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag');
  }
  return key.toString();
}

function hasOwn(obj: unknown, prop: string): boolean {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, prop);
}

/** Non-empty context tier, or null. */
function tier(kase: YamlCase, name: 'global' | 'block' | 'local'): ContextTypes | null {
  const t = kase.contexts?.[name];
  if (!t || typeof t !== 'object' || Object.keys(t).length === 0) return null;
  return t;
}

/** Map the cross-SDK `on_no_default` integer to the Ruby option symbol. */
function onNoDefaultSymbol(val: unknown): string {
  if (val === 1) return ':raise';
  if (val === 2) return ':return_nil';
  throw new Error(`unsupported client_overrides.on_no_default=${JSON.stringify(val)} (1 = raise, 2 = return nil)`);
}

/** YAML context_upload_mode (`:shape_only`, `:none`, ...) -> Ruby option symbol. */
function contextUploadModeSymbol(val: unknown): string {
  const v = String(val).replace(/^:/, '');
  switch (v) {
    case 'none':
      return ':none';
    case 'shape_only':
    case 'shapes_only':
      return ':shapes_only';
    case 'periodic_example':
      return ':periodic_example';
    default:
      throw new Error(`unsupported client_overrides.context_upload_mode=${JSON.stringify(val)}`);
  }
}

function raiseClass(kase: YamlCase): string {
  const errKey = (kase.expected ?? {}).error;
  if (typeof errKey !== 'string' || errKey.length === 0) {
    throw new Error('expected.status: raise but no expected.error provided');
  }
  const errClass = lookupErrorClass('ruby', errKey);
  if (!errClass) {
    throw new Error(
      `no Quonfig::Errors mapping for expected.error="${errKey}". ` +
        `Add it to src/shared/error-mapping.ts (RUBY_ERRORS) or remove the case from YAML.`,
    );
  }
  return errClass;
}

/**
 * Render the body of a single test method (everything between the
 * `def test_*` line and the matching `end`). Always returns a string with
 * a trailing newline; callers concatenate.
 */
function renderBody(yamlBasename: string, kase: YamlCase): string {
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
  if (hasOwn(expected, 'raw_value_type')) {
    throw new Error(
      `expected.raw_value_type is only valid in datadir_value_type.yaml, not ${yamlBasename}`,
    );
  }

  // Cases that override real-client-construction params (init timeout, fake
  // api URL, init-failure policy) need a network-mode client so the SDK's
  // init/timeout/error path actually runs.
  if (hasClientConstructionOverrides(kase.client_overrides)) {
    return renderClientConstructionBody(kase);
  }

  if (yamlBasename === 'post.yaml' || yamlBasename === 'telemetry.yaml') {
    return renderTelemetryBody(kase);
  }

  return renderEvalBody(kase);
}

/**
 * The receiver + call for an eval case, driven through the PUBLIC API:
 *
 *   global tier -> Quonfig::Client.new(global_context: ...)
 *   block tier  -> client.with_context(block)          (a BoundClient)
 *   local tier  -> bound.in_context(local), or the getter's `context:` /
 *                  enabled?'s jit-context argument when there is no block
 *
 * The SDK does the merging; the harness never pre-merges tiers.
 */
interface CallPlan {
  setup: string[]; // lines before the call (without indent)
  call: string; // Ruby expression
}

function planCall(kase: YamlCase): CallPlan {
  const fn = (kase.function ?? 'get').toString();
  const input = kase.input ?? {};
  const key = caseKey(kase);
  const keyLit = rubyLiteral(key);
  const block = tier(kase, 'block');
  const local = tier(kase, 'local');
  const setup: string[] = [];

  let receiver = 'client';
  let jitLocal: ContextTypes | null = null;
  if (block) {
    setup.push(`scope = client.with_context(${rubyLiteral(block)})`);
    if (local) setup.push(`scope = scope.in_context(${rubyLiteral(local)})`);
    receiver = 'scope';
  } else if (local) {
    jitLocal = local;
  }

  const hasDefault = hasOwn(input, 'default');
  const defLit = hasDefault ? rubyLiteral((input as { default?: unknown }).default) : '';

  if (fn === 'enabled') {
    if (hasDefault) throw new Error('function: enabled does not take input.default');
    const args = [keyLit];
    if (jitLocal) args.push(rubyLiteral(jitLocal));
    return { setup, call: `${receiver}.enabled?(${args.join(', ')})` };
  }

  let method: string;
  if (fn === 'get') {
    method = typedGetter(kase);
  } else if (fn === 'get_or_raise') {
    method = 'get_or_raise';
  } else {
    throw new Error(`unsupported function ${JSON.stringify(fn)}`);
  }
  const args = [keyLit];
  if (hasDefault) args.push(`default: ${defLit}`);
  if (jitLocal) args.push(`context: ${rubyLiteral(jitLocal)}`);
  return { setup, call: `${receiver}.${method}(${args.join(', ')})` };
}

function clientOptions(kase: YamlCase): string[] {
  const opts: string[] = [];
  const global = tier(kase, 'global');
  if (global) opts.push(`global_context: ${rubyLiteral(global)}`);
  const overrides = kase.client_overrides ?? {};
  for (const k of Object.keys(overrides)) {
    if (k === 'on_no_default') {
      opts.push(`on_no_default: ${onNoDefaultSymbol(overrides.on_no_default)}`);
    } else {
      throw new Error(`unsupported client_overrides.${k} on an eval case`);
    }
  }
  return opts;
}

/** Assertion lines for a non-raise eval case (no indent, no newline). */
function valueAssertion(kase: YamlCase, call: string): string[] {
  const expected = kase.expected ?? {};
  // Failure message: the public call, without quotes (keeps the literal simple).
  const msg = rubyLiteral(call.replace(/'/g, ''));
  const isDuration = (kase.type ?? '').toString().toUpperCase() === 'DURATION' && kase.function !== 'enabled';

  if (hasOwn(expected, 'millis')) {
    if (!isDuration) throw new Error('expected.millis is only valid on a DURATION case');
    const millis = expected.millis;
    if (!Number.isInteger(millis)) {
      throw new Error(`DURATION case must set expected.millis to an integer, got ${JSON.stringify(millis)}`);
    }
    // Integer-exact milliseconds: no tolerance, no Float.
    return [`assert_kind_of Integer, actual, ${msg}`, `assert_equal ${rubyLiteral(millis)}, actual, ${msg}`];
  }
  if (!hasOwn(expected, 'value')) {
    throw new Error('case has no expected.value or expected.millis');
  }
  const v = expected.value;
  if (v === null || v === undefined) return [`assert_nil actual, ${msg}`];
  if (isDuration) {
    throw new Error(`DURATION case must set expected.millis (or expected.value: ~), got value ${JSON.stringify(v)}`);
  }
  // A Hash literal right after `assert_equal ` would parse as a block.
  if (typeof v === 'object' && !Array.isArray(v)) return [`assert_equal(${rubyLiteral(v)}, actual, ${msg})`];
  return [`assert_equal ${rubyLiteral(v)}, actual, ${msg}`];
}

/** Body for get / enabled / get_or_raise cases against the shared datadir corpus. */
function renderEvalBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const envVars = kase.env_vars;
  const envWrap = !!envVars && typeof envVars === 'object' && Object.keys(envVars).length > 0;
  const indent = envWrap ? '      ' : '    ';

  const opts = clientOptions(kase);
  const plan = planCall(kase);

  const lines: string[] = [];
  lines.push(`client = IntegrationTestHelpers.build_client(${opts.join(', ')})`.replace('build_client()', 'build_client'));
  lines.push(...plan.setup);

  const rspec = repeatSpec(kase);
  if (rspec) {
    repeatValueType(kase, rspec);
    lines.push(`seen = Array.new(${rspec.repeat}) { ${plan.call} }.uniq`);
    lines.push(
      `assert_equal ${rubyLiteral(rspec.valuesSeen)}.sort_by(&:inspect), seen.sort_by(&:inspect),`,
      `             ${rubyLiteral(`expected values seen over ${rspec.repeat} evaluations`)}`,
    );
  } else if (expected.status === 'raise') {
    lines.push(`assert_raises(${raiseClass(kase)}) { ${plan.call} }`);
  } else {
    lines.push(`actual = ${plan.call}`);
    lines.push(...valueAssertion(kase, plan.call));
  }
  lines.push('IntegrationTestHelpers.acknowledge_expected_warnings');

  let body = '';
  if (envWrap) {
    body += `    IntegrationTestHelpers.with_env(${rubyLiteral(stringifyEnvVars(envVars!))}) do\n`;
  }
  for (const l of lines) body += `${indent}${l}\n`;
  if (envWrap) body += `    end\n`;
  return body;
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
 * Render a body for a case that constructs a network-mode Quonfig::Client
 * (init timeout, fake api url, init-failure policy) and calls the YAML's
 * function on it. With on_init_failure: :raise the constructor itself may
 * raise the expected error, so construction sits inside the assert_raises.
 */
function renderClientConstructionBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const overrides = kase.client_overrides ?? {};
  const indent = '    ';

  const onInitFailure = (() => {
    const v = overrides.on_init_failure;
    if (typeof v !== 'string') return 'raise';
    return v.replace(/^:/, '');
  })();
  const timeout =
    typeof overrides.initialization_timeout_sec === 'number'
      ? overrides.initialization_timeout_sec
      : 0.01;
  const apiURL = typeof overrides.prefab_api_url === 'string' ? overrides.prefab_api_url : '';
  if (tier(kase, 'global') || tier(kase, 'block') || tier(kase, 'local')) {
    throw new Error('client-construction cases do not support contexts');
  }

  const build =
    `IntegrationTestHelpers.build_network_client(api_url: ${rubyLiteral(apiURL)}, ` +
    `timeout_sec: ${timeout}, on_init_failure: :${onInitFailure})`;
  const plan = planCall(kase);

  let body = '';
  if (expected.status === 'raise') {
    body += `${indent}client = nil\n`;
    body += `${indent}assert_raises(${raiseClass(kase)}) do\n`;
    body += `${indent}  client = ${build}\n`;
    body += `${indent}  ${plan.call}\n`;
    body += `${indent}end\n`;
  } else {
    body += `${indent}client = ${build}\n`;
    body += `${indent}actual = ${plan.call}\n`;
    for (const l of valueAssertion(kase, plan.call)) body += `${indent}${l}\n`;
  }
  // on_init_failure: :return logs the init failure on purpose; that log line
  // IS the behavior the case asks for.
  body += `${indent}$logs = nil\n`;
  body += `  ensure\n`;
  body += `${indent}client&.stop\n`;
  return body;
}

/**
 * Typed getter for the datadir / delivery suites, which have no contexts.
 */
function datadirCall(kase: YamlCase): string {
  if (tier(kase, 'global') || tier(kase, 'block') || tier(kase, 'local')) {
    throw new Error('datadir/delivery cases do not support contexts');
  }
  return `client.${typedGetter(kase)}(${rubyLiteral(caseKey(kase))})`;
}

/**
 * Render a datadir_environment.yaml case body. Builds a Quonfig::Client
 * directly with `datadir:` + `environment:` overrides, then exercises it
 * through the typed getter (or asserts init raises).
 */
function renderDatadirBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
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
    body += `${indent}assert_raises(${raiseClass(kase)}) { Quonfig::Client.new(${optsLit}) }\n`;
  } else {
    if (!hasOwn(expected, 'value')) {
      throw new Error('datadir get-case has no expected.value');
    }
    body += `${indent}client = Quonfig::Client.new(${optsLit})\n`;
    body += `${indent}assert_equal ${rubyLiteral(expected.value)}, ${datadirCall(kase)}\n`;
  }

  if (useEnv) {
    body += `    end\n`;
  }
  return body;
}

/**
 * Render a datadir_value_type.yaml case body. Builds a real datadir-mode
 * Quonfig::Client, asserts the public typed getter's coerced value, and — when
 * `expected.raw_value_type == "number"` — ALSO asserts the LOADED envelope's
 * raw Value is a Numeric, not a String. `client.store` is a public
 * attr_reader; `store.get(key)` returns the raw ConfigResponse hash, whose
 * raw Value for a simple single-rule ALWAYS_TRUE config lives at
 * `['default']['rules'][0]['value']['value']`.
 */
function renderDatadirValueTypeBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('datadir_value_type case has no input.key/flag');
  }
  if (!hasOwn(expected, 'value')) {
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
  body += `${indent}assert_equal ${rubyLiteral(expected.value)}, ${datadirCall(kase)}\n`;
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
 * Render a delivery_environment.yaml case body. Cross-SDK DELIVERY-WIRE-SHAPE
 * gate (qfg-xpln): stands up a WEBrick server returning the literal `envelope`
 * JSON on /api/v2/configs (the shape api-delivery emits in SDK-key mode),
 * builds a real Quonfig::Client in SDK-key mode (NO environment pin unless
 * client_overrides.environment is set), then asserts the typed getter.
 */
function renderDeliveryBody(kase: YamlCase): string {
  const expected = kase.expected ?? {};
  const overrides = kase.client_overrides ?? {};
  const envelope = kase.envelope;
  const indent = '    ';

  if (!envelope || typeof envelope !== 'object') {
    throw new Error('delivery case has no `envelope` wire shape');
  }
  const key = caseKey(kase);
  if (!hasOwn(expected, 'value')) {
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
  body += `${indent}assert_equal ${expVal ? 'true' : 'false'}, ${datadirCall(kase)},\n`;
  body += `${indent}             ${rubyStringLiteral(`delivery-wire env override: expected ${expVal} for ${key}`)}\n`;
  if ('environment' in overrides) {
    // An explicit env pin in delivery (SDK-key) mode is ignored, and the SDK
    // WARNs about it. The ruby test harness teardown rejects any unhandled log
    // line, so acknowledge the expected WARN here.
    body += `${indent}assert_logged([/was set but the client is in delivery \\(SDK-key\\) mode/])\n`;
  } else {
    // A single explicit api_url disables failover (qfg-41nh.26); the SDK
    // WARNs once. Acknowledge it for the same teardown reason.
    body += `${indent}# A single explicit api_url disables failover (qfg-41nh.26); the SDK warns once.\n`;
    body += `${indent}assert_logged([/explicit api_urls disables automatic failover/])\n`;
  }
  body += `  ensure\n`;
  body += `${indent}client&.stop\n`;
  body += `${indent}server&.shutdown\n`;
  body += `${indent}ENV['QUONFIG_ENVIRONMENT'] = prev_env if prev_env\n`;
  return body;
}

/**
 * Key evaluated to feed a context into the client's telemetry. Contexts only
 * reach telemetry through an evaluation (Client#get & co. record them), so
 * the context_shape / example_contexts cases evaluate this static config
 * under each `data` context. Its eval summary is not part of those
 * projections.
 */
const CONTEXT_PROBE_KEY = 'brand.new.string';

/**
 * Render a post.yaml / telemetry.yaml case body (qfg-2agi.33).
 *
 * Every such case has:
 *   aggregator:    one of context_shape | evaluation_summary | example_contexts
 *   endpoint:      "/api/v1/context-shapes" | "/api/v1/telemetry" (diagnostic)
 *   data:          evaluation_summary -> { keys:, keys_without_context: }
 *                  context_shape / example_contexts -> a context hash or an
 *                  array of context hashes
 *   expected_data: projected POST body (nil = nothing sent)
 *   contexts:      optional block tier for evaluation_summary keys
 *   client_overrides: context_upload_mode / collect_evaluation_summaries
 *
 * The generated test builds a datadir client WITH telemetry on, pointed at a
 * local sink; evaluates through the public client (get_or_raise, scoped with
 * with_context); flushes the client's real reporter; and asserts on what was
 * POSTed. No aggregator is built or fed by the harness.
 */
function renderTelemetryBody(kase: YamlCase): string {
  const aggregator = (kase.aggregator ?? '').toString();
  if (!['context_shape', 'evaluation_summary', 'example_contexts'].includes(aggregator)) {
    throw new Error(`post/telemetry case has unsupported aggregator ${JSON.stringify(aggregator)}`);
  }
  const endpoint = (kase.endpoint ?? '').toString();
  if (endpoint.length === 0) {
    throw new Error('post/telemetry case missing endpoint');
  }
  if (tier(kase, 'global') || tier(kase, 'local')) {
    throw new Error('post/telemetry cases only support the block context tier');
  }
  const block = tier(kase, 'block');

  const data = hasOwn(kase, 'data') ? kase.data : null;
  const expectedData = hasOwn(kase, 'expected_data') ? kase.expected_data : null;

  const opts: string[] = [];
  const overrides = kase.client_overrides ?? {};
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'context_upload_mode') {
      opts.push(`context_upload_mode: ${contextUploadModeSymbol(v)}`);
    } else if (k === 'collect_evaluation_summaries') {
      opts.push(`collect_evaluation_summaries: ${rubyLiteral(v)}`);
    } else {
      throw new Error(`unsupported client_overrides.${k} on a telemetry case`);
    }
  }

  const indent = '    ';
  const lines: string[] = [];
  lines.push('sink = IntegrationTestHelpers::TelemetrySink.start');
  lines.push(`client = IntegrationTestHelpers.build_telemetry_client(${['sink', ...opts].join(', ')})`);

  let returnedArg = '';
  if (aggregator === 'evaluation_summary') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('evaluation_summary data must be { keys:, keys_without_context: }');
    }
    const d = data as Record<string, unknown>;
    const keys = Array.isArray(d.keys) ? (d.keys as unknown[]) : [];
    const keysNoCtx = Array.isArray(d.keys_without_context) ? (d.keys_without_context as unknown[]) : [];
    if (keysNoCtx.length > 0 && !block) {
      throw new Error('keys_without_context without a block context is meaningless');
    }
    lines.push('returned = Hash.new { |h, k| h[k] = [] }');
    if (keys.length > 0) {
      const receiver = block ? 'scope' : 'client';
      if (block) lines.push(`scope = client.with_context(${rubyLiteral(block)})`);
      for (const k of keys) {
        lines.push(`returned[${rubyLiteral(k)}] << ${receiver}.get_or_raise(${rubyLiteral(k)})`);
      }
    }
    for (const k of keysNoCtx) {
      lines.push(`returned[${rubyLiteral(k)}] << client.get_or_raise(${rubyLiteral(k)})`);
    }
    returnedArg = ', returned: returned';
  } else {
    if (block) throw new Error(`${aggregator} cases take their contexts from data, not contexts`);
    const records = Array.isArray(data) ? data : [data ?? {}];
    for (const rec of records) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        throw new Error(`${aggregator} data must be a context hash or an array of them`);
      }
      lines.push(`client.with_context(${rubyLiteral(rec)}).get_or_raise(${rubyLiteral(CONTEXT_PROBE_KEY)})`);
    }
  }

  lines.push(
    `IntegrationTestHelpers.assert_telemetry_post(self, client, sink, :${aggregator}, ${rubyLiteral(expectedData)},`,
    `                                             endpoint: ${rubyLiteral(endpoint)}${returnedArg})`,
  );

  let body = '';
  for (const l of lines) body += `${indent}${l}\n`;
  body += `  ensure\n`;
  body += `${indent}client&.stop\n`;
  body += `${indent}sink&.stop\n`;
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
  rendered.forEach((r, i) => {
    // Layout/EmptyLinesAroundClassBody: no blank line right after `class`.
    out += i === 0 ? r.source.replace(/^\n/, '') : r.source;
  });
  out += `end\n`;
  return out;
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

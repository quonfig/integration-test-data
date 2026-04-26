// Ruby target — generates Minitest files under sdk-ruby/test/integration/.
//
// Ports the previous Ruby-in-Ruby generator (sdk-ruby/scripts/generate_integration_tests.rb)
// with two important behavioral changes:
//
//   1. NO auto-skips. Neither suite-level nor per-case nor wrap-and-rescue.
//      The generator either emits a runnable assertion or, for cases whose
//      shape isn't expressible against the SDK helpers (post.yaml /
//      telemetry.yaml — different schema), omits the case from output AND
//      reports it back to the caller. Runtime failures must surface.
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
  { yaml: 'post.yaml', out: 'test_post.rb', className: 'TestPost' },
  { yaml: 'telemetry.yaml', out: 'test_telemetry.rb', className: 'TestTelemetry' },
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
    if (Number.isInteger(value)) return value.toString();
    return value.toString();
  }
  if (typeof value === 'string') return rubyStringLiteral(value);
  if (Array.isArray(value)) {
    return '[' + value.map(rubyLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${rubyLiteral(k)} => ${rubyLiteral(v)}`,
    );
    return '{' + entries.join(', ') + '}';
  }
  // Fallback — shouldn't hit for the YAML shapes we use.
  return rubyStringLiteral(String(value));
}

/** Quote a string the way Ruby's `String#inspect` does for the safe ASCII subset. */
function rubyStringLiteral(s: string): string {
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

interface OmittedCase {
  yamlBasename: string;
  groupName: string | undefined;
  caseName: string;
  reason: string;
}

interface RenderResult {
  rendered: RenderedCase[];
  omitted: OmittedCase[];
}

/**
 * Render a single suite's cases into Ruby method bodies.
 * Throws for cases that the user has explicitly told us must fail-loud
 * (unmapped raise errors etc). Records "could not generate" entries for
 * cases whose YAML shape isn't expressible (post/telemetry-style).
 */
function renderCases(yamlBasename: string, cases: NormalizedCase[]): RenderResult {
  const rendered: RenderedCase[] = [];
  const omitted: OmittedCase[] = [];
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

    if (body === OMIT_SENTINEL.shape_mismatch) {
      omitted.push({
        yamlBasename,
        groupName: nc.groupName,
        caseName: rawName,
        reason: 'YAML shape (post/telemetry-style data/expected_data/aggregator) not yet expressible in sdk-ruby integration helpers',
      });
      continue;
    }

    const block =
      `\n  # ${rawName}\n` +
      `  def test_${suffix}\n` +
      body +
      `  end\n`;
    rendered.push({ source: block });
  }

  return { rendered, omitted };
}

const OMIT_SENTINEL = {
  shape_mismatch: '__OMIT_SHAPE_MISMATCH__',
} as const;

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

  // post.yaml / telemetry.yaml use a wholly different shape (data,
  // expected_data, aggregator). The current sdk-ruby helpers don't have
  // assertion primitives for these. Per spec we omit + report rather than
  // skip. New generators (or new helpers) should reach this code path
  // and remove the omission.
  const hasShapeOnlyFields =
    'aggregator' in kase || 'expected_data' in kase || 'endpoint' in kase;
  const hasExpressibleShape =
    typeof input === 'object' &&
    (typeof input.key === 'string' || typeof input.flag === 'string');
  if (hasShapeOnlyFields && !hasExpressibleShape) {
    return OMIT_SENTINEL.shape_mismatch;
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

  let inner = '';
  inner += `    resolver = IntegrationTestHelpers.build_resolver(@store)\n`;
  if (envVars && typeof envVars === 'object') {
    inner += `    IntegrationTestHelpers.with_env(${rubyLiteral(stringifyEnvVars(envVars))}) do\n`;
    inner += `      IntegrationTestHelpers.assert_resolved(resolver, ${keyLit}, ${ctxLit}, ${expLit})\n`;
    inner += `    end\n`;
  } else {
    inner += `    IntegrationTestHelpers.assert_resolved(resolver, ${keyLit}, ${ctxLit}, ${expLit})\n`;
  }
  return inner;
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

function stringifyEnvVars(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[String(k)] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

function renderFile(suite: SuiteEntry, rendered: RenderedCase[], omitted: OmittedCase[]): string {
  let out = '';
  out += `# frozen_string_literal: true\n`;
  out += `#\n`;
  out += `# AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}.\n`;
  out += `# Regenerate with:\n`;
  out += `#   cd integration-test-data/generators && npm run generate -- --target=ruby\n`;
  out += `# Source: ${GENERATOR_PATH}\n`;
  out += `# Do NOT edit by hand — changes will be overwritten.\n`;
  if (omitted.length > 0) {
    out += `#\n`;
    out += `# OMITTED CASES (${omitted.length}) — generator could not express these in\n`;
    out += `# the current sdk-ruby integration helpers. Either extend\n`;
    out += `# IntegrationTestHelpers to support the shape, or remove the case from YAML:\n`;
    for (const o of omitted) {
      out += `#   - ${o.caseName} :: ${o.reason}\n`;
    }
  }
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
  written: { path: string; cases: number; omitted: number }[];
  omittedCases: OmittedCase[];
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
  const omittedAll: OmittedCase[] = [];

  for (const suite of SUITES) {
    const yamlPath = resolve(dataRoot, suite.yaml);
    const cases = loadYamlFile(yamlPath, suite.yaml);
    const { rendered, omitted } = renderCases(suite.yaml, cases);
    omittedAll.push(...omitted);
    const src = renderFile(suite, rendered, omitted);
    const outPath = resolve(outDir, suite.out);
    writeFileSync(outPath, src);
    written.push({ path: outPath, cases: rendered.length, omitted: omitted.length });
  }

  return { written, omittedCases: omittedAll };
}

// Java target — generates JUnit 5 test classes under
// sdk-java/src/test/java/com/quonfig/sdk/integration/.
//
// Hard rules (set by project owner):
//
//   1. NO auto-skips, NO omissions, NO defensive shortcuts. Every YAML case
//      becomes a real, runnable `@Test` method. Cases the SDK can't yet
//      satisfy emit code that calls a sensibly-named helper on TestSetup —
//      runtime/compile failure is the *desired* surfacing behavior, not a
//      hidden gap. The TestSetup class itself is added in the SDK-side
//      iteration bead (qfg-mol-5bw); until then, the generated files compile
//      symbol-resolution-wise (file structure, imports, syntax) but their
//      method bodies reference TestSetup.* helpers that don't exist.
//
//   2. Unmapped raise errors and missing input keys FAIL the generator
//      (rather than silently skipping the case at runtime).
//
//   3. Mirrors the structure of python.ts and node.ts — the same six-stage
//      flow (load YAML, render cases, render file, write file). Anything
//      Java-specific (Map.of vs map literal, lambda vs def, checked vs
//      unchecked exceptions) is handled in the helpers below.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import {
  javaSuiteClassName,
  javaTestMethodName,
  uniqueSuffix,
} from '../shared/case-id.js';
import { mergeContexts } from '../shared/contexts.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
import type { ContextTypes, NormalizedCase, YamlCase } from '../types.js';

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

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
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
 * `L` suffix so they auto-box as `Long`, not `Integer` — the SDK's INT type,
 * Jackson's JSON-int parsing (via {@code raw.asLong()}), and the env-var
 * coercion path (`Long.parseLong`) all surface integer values as {@code
 * Long}, so emitting bare {@code int} literals would make
 * `assertEquals(expected, actual)` fail against any of those returns. Non-
 * integers render with a trailing `d` so the JVM treats them as `double`
 * even when they round-trip as e.g. "9.95". NaN/Infinity use the
 * `Double.NaN` / `Double.POSITIVE_INFINITY` constants.
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

function renderCases(suite: SuiteEntry, cases: NormalizedCase[]): RenderResult {
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
      body = renderBody(suite, kase, exceptions);
    } catch (e) {
      throw new GeneratorError(
        `[${suite.yaml}] case "${rawName}": ${(e as Error).message}`,
      );
    }

    const block =
      `\n` +
      `  @Test\n` +
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
): string {
  if (suite.yaml === 'datadir_environment.yaml') {
    return renderDatadirBody(kase, exceptions);
  }
  if (suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml') {
    return renderPostBody(kase);
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

  const indent = '    ';
  const hasEnv = Object.keys(envVars).length > 0;
  const hasClientOverrides = hasClientConstructionOverrides(overrides);

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag and no raise expectation');
  }
  const keyLit = javaStringLiteral(key);
  const ctxLit = renderContextsLiteral(merged);

  let body = '';
  if (hasEnv) {
    body += `${indent}TestSetup.withEnv(${envMapLiteral(envVars)}, () -> {\n`;
  }
  const inner = hasEnv ? indent + '  ' : indent;

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
  kase: YamlCase,
  key: string,
  ctxLit: string,
  expected: { value?: unknown; millis?: number; [k: string]: unknown },
  fn: string,
  yamlType: string,
  input: { default?: unknown; [k: string]: unknown },
  indent: string,
): string {
  const keyLit = javaStringLiteral(key);
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  const def = (input as { default?: unknown }).default;

  // Pick the call shape — same trichotomy as node.ts:
  //   function: enabled → enabledCase
  //   has default       → getCase (mirrors public Quonfig#get)
  //   otherwise         → resolveCase (direct evaluator/resolver path)
  let actualExpr: string;
  if (fn === 'enabled') {
    actualExpr = `TestSetup.enabledCase(${keyLit}, ${ctxLit})`;
  } else if (hasDefault) {
    actualExpr = `TestSetup.getCase(${keyLit}, ${ctxLit}, ${javaLiteral(def)})`;
  } else {
    actualExpr = `TestSetup.resolveCase(${keyLit}, ${ctxLit})`;
  }

  let body = '';
  body += `${indent}Object actual = ${actualExpr};\n`;
  body += renderAssertion(indent, expected, fn, yamlType);
  return body;
}

function renderRaiseBody(
  kase: YamlCase,
  key: string,
  ctxLit: string,
  expected: { error?: string; [k: string]: unknown },
  exceptions: Set<string>,
  indent: string,
): string {
  const keyLit = javaStringLiteral(key);
  const errKey = (expected.error ?? '').toString();
  if (errKey.length === 0) {
    throw new Error('expected.status: raise but no expected.error provided');
  }
  const errClass = lookupErrorClass('java', errKey);
  if (!errClass) {
    throw new Error(
      `no Java error mapping for expected.error="${errKey}". ` +
        `Add it to src/shared/error-mapping.ts (JAVA_ERRORS).`,
    );
  }
  exceptions.add(errClass);
  const shortName = shortClassName(errClass);

  let body = '';
  body += `${indent}assertThrows(${shortName}.class, () ->\n`;
  body += `${indent}    TestSetup.runRaiseCase(${keyLit}, ${ctxLit}, ${javaStringLiteral(errKey)}));\n`;
  return body;
}

function renderClientConstructionBody(
  kase: YamlCase,
  key: string,
  ctxLit: string,
  expected: { value?: unknown; status?: string; error?: string; [k: string]: unknown },
  exceptions: Set<string>,
  indent: string,
): string {
  const keyLit = javaStringLiteral(key);
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
      `${indent}TestSetup.assertInitializationTimeoutError(${keyLit}, ` +
      `${formatJavaNumber(timeoutSec)}, ${javaStringLiteral(apiURL)}, ` +
      `${javaStringLiteral(onInit)});\n`
    );
  }
  if (isRaise) {
    const errClass = lookupErrorClass('java', errKey);
    if (!errClass) {
      throw new Error(
        `no Java error mapping for expected.error="${errKey}" in client-construction case.`,
      );
    }
    exceptions.add(errClass);
    const shortName = shortClassName(errClass);
    return (
      `${indent}TestSetup.assertClientConstructionRaises(${keyLit}, ` +
      `${formatJavaNumber(timeoutSec)}, ${javaStringLiteral(apiURL)}, ` +
      `${javaStringLiteral(onInit)}, ${javaStringLiteral(fn)}, ${shortName}.class);\n`
    );
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    return (
      `${indent}assertEquals(${javaLiteral(expected.value)}, ` +
      `TestSetup.assertClientConstructionValue(${keyLit}, ` +
      `${formatJavaNumber(timeoutSec)}, ${javaStringLiteral(apiURL)}, ` +
      `${javaStringLiteral(onInit)}, ${javaStringLiteral(fn)}));\n`
    );
  }
  throw new Error('client-construction case has no expected.value or expected.error');
}

function renderAssertion(
  indent: string,
  expected: { value?: unknown; millis?: number; [k: string]: unknown },
  fn: string,
  yamlType: string,
): string {
  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    const millis = expected.millis as number;
    // assertDurationMillis lives on TestSetup so the Duration return type
    // and the millis-vs-seconds conversion are encapsulated there. Match the
    // python target's tolerance (1ms).
    return `${indent}TestSetup.assertDurationMillis(actual, ${millis});\n`;
  }
  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('case has no expected.value or expected.millis');
  }
  const v = expected.value;
  if (v === null || v === undefined) {
    return `${indent}assertNull(actual);\n`;
  }
  if (typeof v === 'boolean') {
    return `${indent}assertEquals(${v ? 'true' : 'false'}, actual);\n`;
  }
  if (typeof v === 'number' && !Number.isInteger(v)) {
    // Floating-point: assertEquals(Object, Object) on Doubles uses
    // .equals() which is bit-exact. Use the (double, double, double) overload
    // via TestSetup.assertDoubleEquals so generators can centralize tolerance.
    return `${indent}TestSetup.assertDoubleEquals(${formatJavaNumber(v)}, actual);\n`;
  }
  return `${indent}assertEquals(${javaLiteral(v)}, actual);\n`;
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

function renderContextsLiteral(merged: ContextTypes): string {
  if (Object.keys(merged).length === 0) return 'TestSetup.map()';
  return javaLiteral(merged);
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

/** "com.quonfig.sdk.exceptions.QuonfigKeyNotFoundException" → "QuonfigKeyNotFoundException". */
function shortClassName(fqcn: string): string {
  const idx = fqcn.lastIndexOf('.');
  return idx === -1 ? fqcn : fqcn.slice(idx + 1);
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

  const indent = '    ';
  const hasEnv = Object.keys(envVars).length > 0;

  const opts: string[] = [];
  if ('datadir' in overrides) {
    opts.push(`"datadir", TestSetup.DATADIR`);
  }
  if ('environment' in overrides) {
    opts.push(`"environment", ${javaStringLiteral(String(overrides.environment))}`);
  }
  const optsLit = opts.length > 0 ? `TestSetup.map(${opts.join(', ')})` : 'TestSetup.map()';

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
  } else {
    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('datadir get-case has no input.key/flag');
    }
    if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
      throw new Error('datadir get-case has no expected.value');
    }
    const yamlType = (kase.type ?? 'STRING').toString().toUpperCase();
    body += `${inner}Object actual = TestSetup.datadirGet(${optsLit}, ${javaStringLiteral(key)});\n`;
    body += renderAssertion(inner, expected, func, yamlType);
  }

  if (hasEnv) {
    body += `${indent}});\n`;
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

  const aggLit = javaStringLiteral(aggregator);
  const overridesLit = javaLiteral(overrides);
  const dataLit = javaLiteral(data);
  const expectedLit = javaLiteral(expectedData);
  const endpointLit = javaStringLiteral(endpoint);
  const ctxLit = renderContextsLiteral(merged);

  const indent = '    ';
  let body = '';
  body += `${indent}Object aggregator = TestSetup.buildAggregator(${aggLit}, ${overridesLit});\n`;
  body += `${indent}TestSetup.feedAggregator(aggregator, ${aggLit}, ${dataLit}, ${ctxLit});\n`;
  body += `${indent}assertEquals(${expectedLit}, TestSetup.aggregatorPost(aggregator, ${aggLit}, ${endpointLit}));\n`;
  return body;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function renderFile(suite: SuiteEntry, result: RenderResult): string {
  let out = '';
  out += `// AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `// Regenerate with:\n`;
  out += `//   cd integration-test-data/generators && npm run generate -- --target=java\n`;
  out += `// Source: ${GENERATOR_PATH}\n`;
  out += `\n`;
  out += `package ${PACKAGE};\n`;
  out += `\n`;
  out += `import static org.junit.jupiter.api.Assertions.assertEquals;\n`;
  out += `import static org.junit.jupiter.api.Assertions.assertNull;\n`;
  out += `import static org.junit.jupiter.api.Assertions.assertThrows;\n`;
  out += `\n`;
  out += `import org.junit.jupiter.api.DisplayName;\n`;
  out += `import org.junit.jupiter.api.Test;\n`;

  // Exception classes referenced by raise-cases. Sort for stable output.
  // java.lang.* is auto-imported, so skip those (importing java.lang.X is
  // legal but redundant, and google-java-format / spotless trim such lines).
  const exceptions = Array.from(result.exceptions)
    .filter((fqcn) => !fqcn.startsWith('java.lang.'))
    .sort();
  if (exceptions.length > 0) {
    out += `\n`;
    for (const fqcn of exceptions) {
      out += `import ${fqcn};\n`;
    }
  }

  out += `\n`;
  out += `class ${suite.className} {\n`;
  for (const r of result.rendered) {
    out += r.source;
  }
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
 * @param outDir   sdk-java/src/test/java/com/quonfig/sdk/integration (absolute)
 */
export function runJavaTarget(dataRoot: string, outDir: string): JavaRunResult {
  mkdirSync(outDir, { recursive: true });
  const written: JavaRunResult['written'] = [];

  for (const suite of SUITES) {
    if (suite.className !== javaSuiteClassName(suite.yaml)) {
      throw new Error(
        `[java] class name mismatch for ${suite.yaml}: ` +
          `entry=${suite.className} derived=${javaSuiteClassName(suite.yaml)}`,
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

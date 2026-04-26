// Python target — generates pytest files under sdk-python/tests/integration/.
//
// Hard rules (set by project owner):
//
//   1. NO auto-skips, NO omissions, NO defensive shortcuts. Every YAML case
//      becomes a real, runnable `def test_*` function. Cases the SDK can't
//      yet satisfy emit code that calls a sensibly-named helper or sentinel —
//      runtime failure is the *desired* surfacing behavior, not a hidden gap.
//
//   2. Unmapped raise errors and missing input keys FAIL the generator
//      (rather than silently skipping the case at runtime).
//
//   3. The previous standalone Python generator
//      (scripts/generate_integration_tests_python.py) emitted three skip
//      patterns:
//        - `pytest.skip("requires API-injected prefab-api-key context …")`
//        - `pytest.skip("initialization_timeout tests require async or
//           subprocess")`
//        - banner-listed omissions for post.yaml / telemetry.yaml
//      ALL of these are removed. The replacement: emit a real test that
//      constructs a client / aggregator and asserts the YAML's expected
//      outcome. If the SDK can't replicate the condition, the assertion
//      fails — exactly the right signal.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadYamlFile } from '../yaml-loader.js';
import { pythonTestFunctionName, uniqueSuffix } from '../shared/case-id.js';
import { mergeContexts } from '../shared/contexts.js';
import { lookupErrorClass } from '../shared/error-mapping.js';
import type { ContextTypes, NormalizedCase, YamlCase } from '../types.js';

interface SuiteEntry {
  yaml: string;
  out: string; // basename of generated file (e.g. "test_get.py")
}

const SUITES: SuiteEntry[] = [
  { yaml: 'get.yaml', out: 'test_get.py' },
  { yaml: 'enabled.yaml', out: 'test_enabled.py' },
  { yaml: 'get_or_raise.yaml', out: 'test_get_or_raise.py' },
  { yaml: 'get_feature_flag.yaml', out: 'test_get_feature_flag.py' },
  { yaml: 'get_weighted_values.yaml', out: 'test_get_weighted_values.py' },
  { yaml: 'context_precedence.yaml', out: 'test_context_precedence.py' },
  { yaml: 'enabled_with_contexts.yaml', out: 'test_enabled_with_contexts.py' },
  { yaml: 'datadir_environment.yaml', out: 'test_datadir_environment.py' },
  { yaml: 'post.yaml', out: 'test_post.py' },
  { yaml: 'telemetry.yaml', out: 'test_telemetry.py' },
];

const GENERATOR_PATH = 'integration-test-data/generators/src/targets/python.ts';

class GeneratorError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GeneratorError';
  }
}

// ---------------------------------------------------------------------------
// Python literal rendering
// ---------------------------------------------------------------------------

/** Render a value as a Python literal expression (matches `repr()` shape). */
export function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return formatPyNumber(value);
  if (typeof value === 'string') return pyStringLiteral(value);
  if (Array.isArray(value)) {
    return '[' + value.map(pyLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${pyStringLiteral(k)}: ${pyLiteral(v)}`,
    );
    return '{' + entries.join(', ') + '}';
  }
  return pyStringLiteral(String(value));
}

function formatPyNumber(n: number): string {
  if (Number.isNaN(n)) return "float('nan')";
  if (!Number.isFinite(n)) return n > 0 ? "float('inf')" : "float('-inf')";
  return n.toString();
}

/** Quote a string with single quotes, escaping the usual suspects (mirrors `repr`). */
export function pyStringLiteral(s: string): string {
  // Prefer single quotes unless the string contains one without a double
  // quote — match Python's repr heuristic so generated output reads naturally.
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";

  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === quote) {
      out += '\\' + ch;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      out += '\\x' + code.toString(16).padStart(2, '0');
    } else {
      out += ch;
    }
  }
  out += quote;
  return out;
}

// ---------------------------------------------------------------------------
// Per-suite rendering
// ---------------------------------------------------------------------------

interface RenderedCase {
  /** Full `def test_<suffix>(...):` block, top-level (no leading indent). */
  source: string;
  /** True iff this case takes `config_client` as a fixture argument. */
  usesFixture: boolean;
}

interface RenderResult {
  rendered: RenderedCase[];
  /** Whether at least one case in the suite uses the `config_client` fixture. */
  needsFixture: boolean;
  /** Whether at least one case raises — drives `import pytest` (always true today). */
  needsPytest: boolean;
  /** Set of exception class names referenced — drives `from quonfig.exceptions import …`. */
  exceptions: Set<string>;
}

function renderCases(yamlBasename: string, cases: NormalizedCase[]): RenderResult {
  const rendered: RenderedCase[] = [];
  const seen = new Map<string, number>();
  const exceptions = new Set<string>();
  let needsFixture = false;

  for (const nc of cases) {
    const kase = nc.raw;
    const rawName = (kase.name ?? '').toString();
    const baseSuffix = pythonTestFunctionName(rawName);
    const fnSuffix = uniqueSuffix(seen, baseSuffix);

    let result: { source: string; usesFixture: boolean };
    try {
      result = renderCase(yamlBasename, kase, fnSuffix, exceptions);
    } catch (e) {
      throw new GeneratorError(
        `[${yamlBasename}] case "${rawName}": ${(e as Error).message}`,
      );
    }
    if (result.usesFixture) needsFixture = true;
    rendered.push(result);
  }

  return { rendered, needsFixture, needsPytest: true, exceptions };
}

interface RenderedCaseInternal {
  source: string;
  usesFixture: boolean;
}

/**
 * Render a single `def test_<suffix>(...):` block. Returns the full block
 * including the `def` line and a trailing blank line (so cases are
 * separated by exactly one blank line when concatenated).
 */
function renderCase(
  yamlBasename: string,
  kase: YamlCase,
  fnSuffix: string,
  exceptions: Set<string>,
): RenderedCaseInternal {
  const fnName = `test_${fnSuffix}`;
  const rawName = (kase.name ?? '').toString();
  const header =
    `# ${rawName.replace(/\r?\n/g, ' ')}\n` /* keep one-line comment */;

  if (yamlBasename === 'datadir_environment.yaml') {
    const body = renderDatadirBody(kase, exceptions);
    return {
      source: header + `def ${fnName}() -> None:\n${body}`,
      usesFixture: false,
    };
  }

  if (yamlBasename === 'post.yaml' || yamlBasename === 'telemetry.yaml') {
    const body = renderPostBody(kase);
    return {
      source: header + `def ${fnName}() -> None:\n${body}`,
      usesFixture: false,
    };
  }

  // Eval-style cases: pick fixture vs fresh-client based on whether the
  // YAML overrides client construction (env_vars, custom datadir, custom
  // environment, on_no_default override, or get_or_raise function).
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars ?? {};
  const func = (kase.function ?? 'get').toString();
  const isRaise = expected.status === 'raise';

  const needsFreshClient =
    Object.keys(envVars).length > 0 ||
    'datadir' in overrides ||
    'environment' in overrides ||
    'on_no_default' in overrides ||
    'initialization_timeout_sec' in overrides ||
    func === 'get_or_raise' ||
    isRaise;

  if (needsFreshClient) {
    const body = renderFreshClientBody(kase, exceptions);
    return {
      source: header + `def ${fnName}() -> None:\n${body}`,
      usesFixture: false,
    };
  }

  const body = renderFixtureBody(kase, exceptions);
  return {
    source: header + `def ${fnName}(config_client) -> None:\n${body}`,
    usesFixture: true,
  };
}

// ---------------------------------------------------------------------------
// Eval-style body renderers
// ---------------------------------------------------------------------------

/**
 * Body for cases that can use the module-scoped `config_client` fixture —
 * the happy-path / non-raise cases with no env vars, no datadir/environment
 * overrides, no on_no_default override, and not get_or_raise. 4-space
 * indentation; trailing newline.
 */
function renderFixtureBody(kase: YamlCase, _exceptions: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const merged = mergeContexts(kase.contexts);

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag and no raise expectation');
  }

  const indent = '    ';
  const getterCall = makeGetterCall(kase, key, merged);

  let body = '';
  body += `${indent}c = config_client\n`;
  body += `${indent}result = ${getterCall}\n`;
  body += renderAssertion(indent, expected);
  return body;
}

/**
 * Body for cases that need a fresh `Quonfig(...)` client — env_vars,
 * custom datadir/environment, custom on_no_default, get_or_raise, or a
 * raise expectation. 4-space indentation; trailing newline.
 */
function renderFreshClientBody(kase: YamlCase, exceptions: Set<string>): string {
  const expected = kase.expected ?? {};
  const input = kase.input ?? {};
  const overrides = kase.client_overrides ?? {};
  const envVars = kase.env_vars ?? {};
  const merged = mergeContexts(kase.contexts);
  const func = (kase.function ?? 'get').toString();
  const isRaise = expected.status === 'raise';

  const key = (input.key ?? input.flag) as string | undefined;
  if (!key || key.toString().length === 0) {
    throw new Error('case has no input.key/flag and no raise expectation');
  }

  const clientArgs = buildClientArgs(kase);
  const getterCall = makeGetterCall(kase, key, merged);
  const hasEnv = Object.keys(envVars).length > 0;

  const indent = '    ';
  const inner = hasEnv ? '        ' : indent;
  let body = '';

  if (hasEnv) {
    body += `${indent}env_backup: dict[str, str | None] = {}\n`;
    for (const [k, v] of Object.entries(envVars)) {
      const sval = v === null || v === undefined ? '' : String(v);
      body += `${indent}env_backup[${pyStringLiteral(k)}] = os.environ.get(${pyStringLiteral(k)})\n`;
      body += `${indent}os.environ[${pyStringLiteral(k)}] = ${pyStringLiteral(sval)}\n`;
    }
    body += `${indent}try:\n`;
  }

  body += `${inner}c = Quonfig(${clientArgs})\n`;
  body += `${inner}c.init()\n`;

  if (isRaise) {
    const errKey = (expected.error ?? '').toString();
    if (errKey.length === 0) {
      throw new Error('raise case missing expected.error');
    }
    const errClass = lookupErrorClass('python', errKey);
    if (!errClass) {
      throw new Error(
        `no Python error mapping for expected.error="${errKey}". ` +
          `Add it to src/shared/error-mapping.ts (PYTHON_ERRORS).`,
      );
    }
    if (errClass.startsWith('Quonfig')) {
      exceptions.add(errClass);
    }
    body += `${inner}with pytest.raises(${errClass}):\n`;
    body += `${inner}    ${getterCall}\n`;
  } else {
    body += `${inner}result = ${getterCall}\n`;
    body += renderAssertion(inner, expected);
  }

  if (hasEnv) {
    body += `${indent}finally:\n`;
    body += `${indent}    for k, v in env_backup.items():\n`;
    body += `${indent}        if v is None:\n`;
    body += `${indent}            os.environ.pop(k, None)\n`;
    body += `${indent}        else:\n`;
    body += `${indent}            os.environ[k] = v\n`;
  }
  return body;
}

/** Build the `Quonfig(datadir=…, environment=…, …)` argument list. */
function buildClientArgs(kase: YamlCase): string {
  const overrides = kase.client_overrides ?? {};
  const func = (kase.function ?? 'get').toString();
  const expected = kase.expected ?? {};
  const isRaise = expected.status === 'raise';

  const parts: string[] = [];

  // datadir — either the default integration-tests dir or a YAML override
  // (currently only "integration-tests" is referenced, but support arbitrary
  // names so future YAML can flex).
  if (
    'datadir' in overrides &&
    typeof overrides.datadir === 'string' &&
    overrides.datadir !== 'integration-tests'
  ) {
    parts.push(
      `datadir=os.path.join(os.path.dirname(__file__), "../../../integration-test-data/data/${overrides.datadir}")`,
    );
  } else {
    parts.push(`datadir=DATADIR`);
  }

  if ('environment' in overrides) {
    parts.push(`environment=${pyStringLiteral(String(overrides.environment))}`);
  } else {
    parts.push(`environment="Production"`);
  }

  if ('on_no_default' in overrides) {
    parts.push(`on_no_default=${pyStringLiteral(onNoDefaultStr(overrides.on_no_default))}`);
  } else if (func === 'get_or_raise') {
    parts.push(`on_no_default="error"`);
  } else if (!isRaise) {
    parts.push(`on_init_failure="return_zero_value"`);
  }

  if (typeof overrides.initialization_timeout_sec === 'number') {
    // The Python SDK's option name might be `init_timeout` or
    // `initialization_timeout`. Use the YAML name verbatim — if the SDK
    // doesn't accept it, the constructor will raise and the test will
    // fail loudly (correctly surfacing the gap).
    parts.push(`initialization_timeout_sec=${overrides.initialization_timeout_sec}`);
  }
  if (typeof overrides.on_init_failure === 'string') {
    const onInit = overrides.on_init_failure.replace(/^:/, '');
    parts.push(`on_init_failure=${pyStringLiteral(onInit)}`);
  }
  if (typeof overrides.prefab_api_url === 'string') {
    parts.push(`prefab_api_url=${pyStringLiteral(overrides.prefab_api_url)}`);
  }

  return parts.join(', ');
}

/**
 * Map the cross-SDK `on_no_default` integer to the Python SDK string
 * argument. Mirrors the old generator's mapping. 2 historically meant
 * "strict" but the cross-SDK suite still expects None on missing keys, so
 * we use "warn" — flipping to "error" would break unrelated cases.
 */
function onNoDefaultStr(val: unknown): string {
  if (val === 0) return 'ignore';
  if (val === 1) return 'warn';
  if (val === 2) return 'warn';
  return 'warn';
}

/**
 * Build the getter-call expression: `c.get_string(key, default=…, contexts=…)`,
 * `c.is_feature_enabled(flag, contexts=…)`, etc.
 */
function makeGetterCall(kase: YamlCase, key: string, merged: ContextTypes): string {
  const input = kase.input ?? {};
  const func = (kase.function ?? 'get').toString();
  const yamlType = (kase.type ?? 'STRING').toString().toUpperCase();
  const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
  const def = (input as { default?: unknown }).default;

  const ctxLit = renderContextsLiteral(merged);
  const keyLit = pyStringLiteral(key);

  if (func === 'enabled') {
    if (ctxLit !== '{}') {
      return `c.is_feature_enabled(${keyLit}, contexts=${ctxLit})`;
    }
    return `c.is_feature_enabled(${keyLit})`;
  }

  const methodMap: Record<string, string> = {
    STRING: 'get_string',
    INT: 'get_int',
    DOUBLE: 'get_float',
    BOOLEAN: 'get_bool',
    STRING_LIST: 'get_string_list',
    JSON: 'get_json',
    DURATION: 'get_duration',
    LOG_LEVEL: 'get_string',
  };
  const method = methodMap[yamlType] ?? 'get_string';

  const kwargs: string[] = [];
  if (hasDefault) kwargs.push(`default=${pyLiteral(def)}`);
  if (ctxLit !== '{}') kwargs.push(`contexts=${ctxLit}`);

  if (kwargs.length === 0) {
    return `c.${method}(${keyLit})`;
  }
  return `c.${method}(${keyLit}, ${kwargs.join(', ')})`;
}

/** Render a merged-context map as a Python dict literal, or `{}` if empty. */
function renderContextsLiteral(merged: ContextTypes): string {
  if (Object.keys(merged).length === 0) return '{}';
  return pyLiteral(merged);
}

/**
 * Render the assertion line(s) for a happy-path expectation. Handles
 * `expected.millis` (duration), array/dict equality, bool identity,
 * float tolerance, and the catch-all equality check.
 */
function renderAssertion(indent: string, expected: { value?: unknown; millis?: number; [k: string]: unknown }): string {
  if (Object.prototype.hasOwnProperty.call(expected, 'millis')) {
    const millis = expected.millis as number;
    return `${indent}assert abs(result * 1000 - ${millis}) < 1, f"Expected {result * 1000}ms to be close to ${millis}ms"\n`;
  }
  if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('case has no expected.value or expected.millis');
  }
  const v = expected.value;
  if (v === null || v === undefined) {
    return `${indent}assert result is None\n`;
  }
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
    return `${indent}assert result == ${pyLiteral(v)}\n`;
  }
  if (typeof v === 'boolean') {
    return `${indent}assert result is ${pyLiteral(v)}\n`;
  }
  if (typeof v === 'number' && !Number.isInteger(v)) {
    return `${indent}assert abs(result - ${pyLiteral(v)}) < 1e-9\n`;
  }
  return `${indent}assert result == ${pyLiteral(v)}\n`;
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
  const inner = hasEnv ? '        ' : indent;

  const opts: string[] = [];
  if ('datadir' in overrides) {
    opts.push('datadir=DATADIR');
  }
  if ('environment' in overrides) {
    opts.push(`environment=${pyStringLiteral(String(overrides.environment))}`);
  }
  const optsRendered = opts.join(', ');

  let body = '';
  if (hasEnv) {
    body += `${indent}env_backup: dict[str, str | None] = {}\n`;
    for (const [k, v] of Object.entries(envVars)) {
      const sval = v === null || v === undefined ? '' : String(v);
      body += `${indent}env_backup[${pyStringLiteral(k)}] = os.environ.get(${pyStringLiteral(k)})\n`;
      body += `${indent}os.environ[${pyStringLiteral(k)}] = ${pyStringLiteral(sval)}\n`;
    }
    body += `${indent}try:\n`;
  }

  if (func === 'init' && isRaise) {
    const errKey = (expected.error ?? '').toString();
    if (errKey.length === 0) {
      throw new Error('init raise case missing expected.error');
    }
    const errClass = lookupErrorClass('python', errKey);
    if (!errClass) {
      throw new Error(
        `no Python error mapping for expected.error="${errKey}" in datadir init case.`,
      );
    }
    if (errClass.startsWith('Quonfig')) {
      exceptions.add(errClass);
    }
    body += `${inner}c = Quonfig(${optsRendered})\n`;
    body += `${inner}with pytest.raises(${errClass}):\n`;
    body += `${inner}    c.init()\n`;
  } else {
    const key = (input.key ?? input.flag) as string | undefined;
    if (!key || key.toString().length === 0) {
      throw new Error('datadir get-case has no input.key/flag');
    }
    if (!Object.prototype.hasOwnProperty.call(expected, 'value')) {
      throw new Error('datadir get-case has no expected.value');
    }
    const yamlType = (kase.type ?? 'STRING').toString().toUpperCase();
    const methodMap: Record<string, string> = {
      STRING: 'get_string',
      INT: 'get_int',
      DOUBLE: 'get_float',
      BOOLEAN: 'get_bool',
      STRING_LIST: 'get_string_list',
      JSON: 'get_json',
      DURATION: 'get_duration',
    };
    const method = methodMap[yamlType] ?? 'get_string';

    body += `${inner}c = Quonfig(${optsRendered})\n`;
    body += `${inner}c.init()\n`;
    body += `${inner}result = c.${method}(${pyStringLiteral(key)})\n`;
    body += renderAssertion(inner, expected);
  }

  if (hasEnv) {
    body += `${indent}finally:\n`;
    body += `${indent}    for k, v in env_backup.items():\n`;
    body += `${indent}        if v is None:\n`;
    body += `${indent}            os.environ.pop(k, None)\n`;
    body += `${indent}        else:\n`;
    body += `${indent}            os.environ[k] = v\n`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// post.yaml / telemetry.yaml renderer
// ---------------------------------------------------------------------------

/**
 * Render a post.yaml / telemetry.yaml case body using the uniform
 * three-call aggregator helper API:
 *
 *   agg = build_aggregator(kind, overrides)
 *   feed_aggregator(agg, kind, data, contexts=…)
 *   assert aggregator_post(agg, kind, endpoint=…) == expected_data
 *
 * None of those helpers exist in `sdk-python/tests/integration/aggregator_helpers`
 * today. That's fine — at runtime the import (or the call) raises, which
 * is the *desired* surfacing behavior. Hiding the case via a generator-side
 * omission is strictly worse.
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

  const aggLit = pyStringLiteral(aggregator);
  const overridesLit = pyLiteral(overrides);
  const dataLit = pyLiteral(data);
  const expectedLit = pyLiteral(expectedData);
  const endpointLit = pyStringLiteral(endpoint);
  const ctxLit = renderContextsLiteral(merged);

  const indent = '    ';
  let body = '';
  body += `${indent}agg = build_aggregator(${aggLit}, ${overridesLit})\n`;
  body += `${indent}feed_aggregator(agg, ${aggLit}, ${dataLit}, contexts=${ctxLit})\n`;
  body += `${indent}assert aggregator_post(agg, ${aggLit}, endpoint=${endpointLit}) == ${expectedLit}\n`;
  return body;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function renderFile(suite: SuiteEntry, result: RenderResult): string {
  const isDatadir = suite.yaml === 'datadir_environment.yaml';
  const isPost = suite.yaml === 'post.yaml' || suite.yaml === 'telemetry.yaml';

  let out = '';
  out += `# AUTO-GENERATED from integration-test-data/tests/eval/${suite.yaml}. DO NOT EDIT.\n`;
  out += `# Regenerate with:\n`;
  out += `#   cd integration-test-data/generators && npm run generate -- --target=python\n`;
  out += `# Source: ${GENERATOR_PATH}\n`;
  out += `\n`;
  out += `from __future__ import annotations\n\n`;
  out += `import os\n\n`;
  out += `import pytest\n\n`;

  if (isPost) {
    // Aggregator helpers — these don't exist yet. Importing them will fail
    // at module-load time once that module doesn't exist. Either failure
    // surfaces the gap correctly.
    out += `from .aggregator_helpers import build_aggregator, feed_aggregator, aggregator_post\n\n`;
  } else {
    out += `from quonfig import Quonfig\n`;
    if (result.exceptions.size > 0) {
      const sortedExc = Array.from(result.exceptions).sort();
      out += `from quonfig.exceptions import (\n`;
      for (const exc of sortedExc) {
        out += `    ${exc},\n`;
      }
      out += `)\n`;
    }
    out += `\n`;
    out += `DATADIR = os.path.join(\n`;
    out += `    os.path.dirname(__file__),\n`;
    out += `    "../../../integration-test-data/data/integration-tests",\n`;
    out += `)\n\n`;
  }

  if (result.needsFixture && !isPost && !isDatadir) {
    out += `@pytest.fixture(scope="module")\n`;
    out += `def config_client():\n`;
    out += `    os.environ.setdefault(\n`;
    out += `        "PREFAB_INTEGRATION_TEST_ENCRYPTION_KEY",\n`;
    out += `        "c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221",\n`;
    out += `    )\n`;
    out += `    os.environ.setdefault("IS_A_NUMBER", "1234")\n`;
    out += `    os.environ.setdefault("NOT_A_NUMBER", "not_a_number")\n`;
    out += `    os.environ.pop("MISSING_ENV_VAR", None)\n`;
    out += `    c = Quonfig(\n`;
    out += `        datadir=DATADIR,\n`;
    out += `        environment="Production",\n`;
    out += `        on_init_failure="return_zero_value",\n`;
    out += `    )\n`;
    out += `    c.init()\n`;
    out += `    return c\n\n\n`;
  }

  for (let i = 0; i < result.rendered.length; i++) {
    const r = result.rendered[i];
    out += r.source;
    if (i < result.rendered.length - 1) {
      out += '\n\n';
    }
  }
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface PythonRunResult {
  written: { path: string; cases: number }[];
}

/**
 * Entry point used by src/index.ts.
 *
 * @param dataRoot integration-test-data/tests/eval (absolute)
 * @param outDir   sdk-python/tests/integration     (absolute)
 */
export function runPythonTarget(dataRoot: string, outDir: string): PythonRunResult {
  mkdirSync(outDir, { recursive: true });
  const written: PythonRunResult['written'] = [];

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateYaml, validateObject } from '../src/validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const SCENARIOS = join(HERE, '..', '..', 'scenarios');
const SCENARIOS_HTTP_PROXY = join(HERE, '..', '..', 'scenarios-http-proxy');
const SCENARIOS_FAILOVER = join(HERE, '..', '..', 'scenarios-failover');
const SCENARIOS_ORDERING = join(HERE, '..', '..', 'scenarios-ordering');

function load(rel: string): string {
  return readFileSync(rel, 'utf8');
}

test('good fixture validates cleanly', () => {
  const result = validateYaml(load(join(FIXTURES, 'good.yaml')));
  assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
});

test('rejects expectation missing within_ms (time-bounded requirement)', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-no-within-ms.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /within_ms/.test(e)),
    `expected a within_ms error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('rejects empty expectations (a chaos test must assert something)', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-no-expectations.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /expectations/.test(e) || /minItems/.test(e)),
    `expected an expectations error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('rejects unknown toxiproxy toxic types', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-unknown-toxic.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /not_a_real_toxic|toxic/.test(e)),
    `expected a toxic-type error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('every default-suite scenario in chaos/scenarios/*.yaml validates', () => {
  const files = readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 10, `expected at least 10 default scenarios, found ${files.length}`);
  const failures: string[] = [];
  for (const f of files) {
    const result = validateYaml(load(join(SCENARIOS, f)));
    if (!result.valid) {
      failures.push(`${f}: ${JSON.stringify(result.errors)}`);
    }
  }
  assert.deepEqual(failures, [], `scenarios failed validation:\n${failures.join('\n')}`);
});

test('every http-proxy scenario in chaos/scenarios-http-proxy/*.yaml validates', () => {
  const files = readdirSync(SCENARIOS_HTTP_PROXY).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 1, `expected at least 1 http-proxy scenario, found ${files.length}`);
  const failures: string[] = [];
  for (const f of files) {
    const result = validateYaml(load(join(SCENARIOS_HTTP_PROXY, f)));
    if (!result.valid) {
      failures.push(`${f}: ${JSON.stringify(result.errors)}`);
    }
  }
  assert.deepEqual(failures, [], `scenarios failed validation:\n${failures.join('\n')}`);
});

test('scenarios cover the 11 named cases from the plan (across all suites)', () => {
  const defaultFiles = readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'));
  const httpProxyFiles = readdirSync(SCENARIOS_HTTP_PROXY).filter((f) => f.endsWith('.yaml'));
  const files = [...defaultFiles, ...httpProxyFiles];
  const required = [
    'baseline',
    'silent-stall',
    'latency',
    'bandwidth',
    'sse-down',
    'total-partition',
    'half-open',
    'auth',
    'flapping',
    'callback-throw',
    'null-hypothesis',
  ];
  const missing = required.filter((tag) => !files.some((f) => f.includes(tag)));
  assert.deepEqual(missing, [], `missing scenario tags: ${missing.join(', ')}`);
});

test('every failover scenario in chaos/scenarios-failover/*.yaml validates', () => {
  const files = readdirSync(SCENARIOS_FAILOVER).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 5, `expected at least 5 failover scenarios, found ${files.length}`);
  const failures: string[] = [];
  for (const f of files) {
    const result = validateYaml(load(join(SCENARIOS_FAILOVER, f)));
    if (!result.valid) {
      failures.push(`${f}: ${JSON.stringify(result.errors)}`);
    }
  }
  assert.deepEqual(failures, [], `scenarios failed validation:\n${failures.join('\n')}`);
});

test('every ordering scenario in chaos/scenarios-ordering/*.yaml validates', () => {
  const files = readdirSync(SCENARIOS_ORDERING).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 5, `expected at least 5 ordering scenarios, found ${files.length}`);
  const failures: string[] = [];
  for (const f of files) {
    const result = validateYaml(load(join(SCENARIOS_ORDERING, f)));
    if (!result.valid) {
      failures.push(`${f}: ${JSON.stringify(result.errors)}`);
    }
  }
  assert.deepEqual(failures, [], `scenarios failed validation:\n${failures.join('\n')}`);
});

test('failover suite covers f01-f05; ordering suite covers o01-o05', () => {
  const failoverFiles = readdirSync(SCENARIOS_FAILOVER).filter((f) => f.endsWith('.yaml'));
  const orderingFiles = readdirSync(SCENARIOS_ORDERING).filter((f) => f.endsWith('.yaml'));
  const requiredFailover = ['f01', 'f02', 'f03', 'f04', 'f05'];
  const requiredOrdering = ['o01', 'o02', 'o03', 'o04', 'o05'];
  const missingFailover = requiredFailover.filter((tag) => !failoverFiles.some((f) => f.includes(tag)));
  const missingOrdering = requiredOrdering.filter((tag) => !orderingFiles.some((f) => f.includes(tag)));
  assert.deepEqual(missingFailover, [], `missing failover scenarios: ${missingFailover.join(', ')}`);
  assert.deepEqual(missingOrdering, [], `missing ordering scenarios: ${missingOrdering.join(', ')}`);
});

test('schema accepts the failover topology + primary-leg inject vocabulary', () => {
  const doc = {
    function: 'failover',
    tests: [
      {
        name: 'probe',
        setup: { sdk: 'any', topology: 'failover', sse_endpoint: 'disabled', http_endpoint: 'failover' },
        chaos: [
          { at_ms: 0, inject: { name: 'p', proxy: 'primary', primary_refused_ms: 8000 } },
          { at_ms: 0, inject: { proxy: 'primary', primary_hang_ms: 30000 } },
          { at_ms: 0, inject: { proxy: 'primary', primary_latency_ms: 30000 } },
          { at_ms: 0, inject: { proxy: 'secondary', toxic: { type: 'latency', attributes: { latency: 10 } } } },
        ],
        expectations: [{ within_ms: 4000, assert: "client.resolvedFrom() == 'secondary'" }],
      },
    ],
  };

  const result = validateObject(doc);
  assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
});

test('schema accepts the ordering topology + per-upstream generation vocabulary', () => {
  const doc = {
    function: 'ordering',
    tests: [
      {
        name: 'probe',
        setup: {
          sdk: 'any',
          topology: 'ordering',
          sse_endpoint: 'disabled',
          upstreams: [
            { role: 'primary', generation: 7 },
            { role: 'secondary', generation: 8 },
          ],
        },
        expectations: [{ within_ms: 4000, assert: 'client.heldGeneration() == 8' }],
      },
    ],
  };

  const result = validateObject(doc);
  assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
});

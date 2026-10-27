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

test('accepts the http_status alias on the config fetch endpoint (scenario 08)', () => {
  const result = validateYaml(load(join(FIXTURES, 'good-http-status.yaml')));
  assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
});

test('rejects an inject carrying both sse_http_status and http_status (one alias per inject)', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-two-status-aliases.yaml')));
  assert.equal(result.valid, false);
});

test('accepts after_ms on an expectation (absolute ms from t=0)', () => {
  const result = validateYaml(load(join(FIXTURES, 'good-after-ms.yaml')));
  assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
});

test('rejects an unknown expectation key (no silently dropped timing field)', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-unknown-expectation-key.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /not_before_ms/.test(e)),
    `expected the unknown key to be named, got: ${JSON.stringify(result.errors)}`,
  );
});

test('rejects must_hold_for_ms > within_ms (hold cannot finish inside its window)', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-hold-exceeds-within.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /must_hold_for_ms/.test(e) && /within_ms/.test(e)),
    `expected a hold/within error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('rejects after_ms >= within_ms (nothing left to evaluate)', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-after-ge-within.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /after_ms/.test(e) && /within_ms/.test(e)),
    `expected an after/within error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('rejects after_ms + must_hold_for_ms > within_ms', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-after-plus-hold-exceeds-within.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /after_ms \+ must_hold_for_ms/.test(e)),
    `expected an after+hold error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('accepts the init-failure setup keys (scenario 00)', () => {
  const result = validateYaml(load(join(SCENARIOS, '00-boot-both-down-then-restore.yaml')));
  assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
});

test('rejects catch_init_failure outside on_init_failure fail', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-catch-without-fail.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /catch_init_failure/.test(e)),
    `expected a catch_init_failure error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('rejects a deprecated alias as the chaos on_init_failure (canonical values only)', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-init-failure-mode.yaml')));
  assert.equal(result.valid, false);
});

test('rejects init_timeout_ms without on_init_failure', () => {
  const result = validateYaml(load(join(FIXTURES, 'bad-init-timeout-without-mode.yaml')));
  assert.equal(result.valid, false);
  assert.ok(
    result.errors!.some((e) => /init_timeout_ms/.test(e) && /on_init_failure/.test(e)),
    `expected an init_timeout_ms/on_init_failure error, got: ${JSON.stringify(result.errors)}`,
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

test('scenario 08 auth-failed holds start at entry and end inside the window (qfg-goi1.10.38)', async () => {
  // Timeline rules 1 and 3: an auth-failed hold must not start before entry
  // (~125s, margin to 145s), must end no more than 5s short of within_ms, and
  // within_ms must leave 5s of slack before wall_clock_seconds.
  const yaml = await import('js-yaml');
  const doc = yaml.load(load(join(SCENARIOS_HTTP_PROXY, '08-auth-failure.yaml'))) as {
    tests: Array<{
      setup: { wall_clock_seconds: number };
      expectations: Array<{ within_ms: number; after_ms?: number; must_hold_for_ms?: number }>;
    }>;
  };
  const t = doc.tests[0];
  const wallMs = t.setup.wall_clock_seconds * 1000;
  const holds = t.expectations.filter((e) => e.must_hold_for_ms !== undefined);
  assert.equal(holds.length, 3, 'expected the three auth-failed hold rows');
  holds.forEach((e, i) => {
    const after = e.after_ms ?? 0;
    const end = after + e.must_hold_for_ms!;
    assert.equal(after, 145000, `08 hold row ${i}: after_ms must be the entry deadline 145000`);
    assert.ok(e.within_ms - end <= 5000, `08 hold row ${i}: hold ends ${e.within_ms - end}ms short of within_ms`);
    assert.ok(e.within_ms + 5000 <= wallMs, `08 hold row ${i}: within_ms ${e.within_ms} leaves <5s before wall clock ${wallMs}`);
  });
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

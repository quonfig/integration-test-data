import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateYaml } from '../src/validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const SCENARIOS = join(HERE, '..', '..', 'scenarios');

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

test('every scenario in chaos/scenarios/*.yaml validates', () => {
  const files = readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 11, `expected at least 11 scenarios, found ${files.length}`);
  const failures: string[] = [];
  for (const f of files) {
    const result = validateYaml(load(join(SCENARIOS, f)));
    if (!result.valid) {
      failures.push(`${f}: ${JSON.stringify(result.errors)}`);
    }
  }
  assert.deepEqual(failures, [], `scenarios failed validation:\n${failures.join('\n')}`);
});

test('scenarios cover the 11 named cases from the plan', () => {
  const files = readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'));
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

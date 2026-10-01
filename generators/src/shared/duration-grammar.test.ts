import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';

// Self-check for tests/duration/grammar.yaml (qfg-2agi.29). Re-derives the
// decided grammar independently: every valid entry must parse and its millis
// must equal the exact-decimal, round-half-up value; every invalid entry
// must be rejected. BigInt only, no floats.

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../tests/duration/grammar.yaml');

interface Fixture {
  valid: { value: string; millis: number }[];
  invalid: string[];
}

const GRAMMAR = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?$/;
const MAX_NANOS = 36500n * 86400n * 1_000_000_000n;

/** Returns exact millis (BigInt) or null if the value is outside the grammar. */
export function parseDurationMillis(value: string): bigint | null {
  const m = GRAMMAR.exec(value);
  if (!m) return null;
  const [, d, h, min, s, frac] = m;
  if (d === undefined && h === undefined && min === undefined && s === undefined) return null;
  if (value.endsWith('T')) return null; // dangling T
  if (frac !== undefined && frac.length > 9) return null;
  const nanos =
    BigInt(d ?? '0') * 86400n * 1_000_000_000n +
    BigInt(h ?? '0') * 3600n * 1_000_000_000n +
    BigInt(min ?? '0') * 60n * 1_000_000_000n +
    BigInt(s ?? '0') * 1_000_000_000n +
    BigInt((frac ?? '').padEnd(9, '0'));
  if (nanos > MAX_NANOS) return null;
  const ms = nanos / 1_000_000n;
  return nanos % 1_000_000n >= 500_000n ? ms + 1n : ms;
}

const fixture = yaml.load(readFileSync(fixturePath, 'utf8')) as Fixture;

test('fixture has the documented shape', () => {
  assert.ok(Array.isArray(fixture.valid) && fixture.valid.length > 0);
  assert.ok(Array.isArray(fixture.invalid) && fixture.invalid.length > 0);
  for (const v of fixture.valid) {
    assert.equal(typeof v.value, 'string');
    assert.ok(Number.isSafeInteger(v.millis), `${v.value}: millis must be a safe integer`);
  }
  for (const v of fixture.invalid) assert.equal(typeof v, 'string');
});

for (const { value, millis } of fixture.valid) {
  test(`valid ${JSON.stringify(value)} = ${millis} ms`, () => {
    assert.equal(parseDurationMillis(value), BigInt(millis));
  });
}

for (const value of fixture.invalid) {
  test(`invalid ${JSON.stringify(value)} is rejected`, () => {
    assert.equal(parseDurationMillis(value), null);
  });
}

test('no value is listed as both valid and invalid', () => {
  const valid = new Set(fixture.valid.map((v) => v.value));
  for (const v of fixture.invalid) assert.ok(!valid.has(v), `${JSON.stringify(v)} in both lists`);
});

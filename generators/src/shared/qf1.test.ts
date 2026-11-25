// qf1 test data (bead qfg-8seuf.3): the fixtures, the YAML cases and the
// generator's keysets block agree with tests/secrets/qf1-vectors.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYamlFile } from '../yaml-loader.js';
import { qf1Drift } from '../qf1-sync.js';
import { QF1_BAD_KEYSET_NAME_FIXTURE, caseKeysets, qf1TestKeyEntry, qf1TestKeysetValue, rejectKeysets } from './qf1.js';
import {
  QF1_VECTORS_PATH,
  checkVectors,
  corpusKeysets,
  expectedSecretValue,
  qf1FixtureKeys,
  redactedValue,
  storedSecretValue,
  type Qf1Vectors,
} from './qf1-fixtures.js';
import type { NormalizedCase, YamlCase } from '../types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const vectors = JSON.parse(readFileSync(resolve(repoRoot, QF1_VECTORS_PATH), 'utf8')) as Qf1Vectors;
const evalDir = resolve(repoRoot, 'tests', 'eval');
const corpus: NormalizedCase[] = readdirSync(evalDir)
  .filter((f) => f.endsWith('.yaml'))
  .flatMap((f) => loadYamlFile(resolve(evalDir, f), f));
const secretKeys = new Set(qf1FixtureKeys().secrets);

/** Every config key a case reads. */
function keysRead(kase: YamlCase): string[] {
  const out: string[] = [];
  const input = kase.input ?? {};
  for (const k of [input.key, input.flag]) if (typeof k === 'string') out.push(k);
  const data = kase.data as { keys?: unknown; keys_without_context?: unknown } | null | undefined;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const list of [data.keys, data.keys_without_context]) {
      if (Array.isArray(list)) for (const k of list) if (typeof k === 'string') out.push(k);
    }
  }
  return out;
}

// .gitleaks.toml exempts tests/secrets/qf1-vectors.json from secret scanning,
// so the file must stay the approved copy of project/plans/secrets-qf1/
// vectors.json. Changing it means changing this hash in the same reviewed PR.
const APPROVED_VECTORS_SHA256 = 'dd4ce106ca43f025c34de41bec765b144f13131375da499621c1098d5f22de5f';

test('tests/secrets/qf1-vectors.json is the approved vectors file', () => {
  const actual = createHash('sha256').update(readFileSync(resolve(repoRoot, QF1_VECTORS_PATH))).digest('hex');
  assert.equal(actual, APPROVED_VECTORS_SHA256);
});

test('qf1 fixtures match what tests/secrets/qf1-vectors.json gives', () => {
  assert.deepEqual(qf1Drift().problems, []);
});

test('every qf1 test key is the label derivation the generated helpers implement', () => {
  checkVectors(vectors);
  for (const ks of vectors.keysets) {
    for (const k of ks.keys) assert.equal(qf1TestKeyEntry(k.label), k.privateKeyEntry, k.label);
  }
});

test('the corpus keyset values hold exactly the keys of the vectors positiveEnv', () => {
  // positiveEnv pads with whitespace and a trailing comma; compare the entries.
  const entries = (v: string): string[] =>
    v
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0)
      .sort();
  for (const [name, labels] of Object.entries(corpusKeysets(vectors))) {
    if (name === QF1_BAD_KEYSET_NAME_FIXTURE) continue; // not a positiveEnv keyset; checked by checkVectors
    assert.deepEqual(entries(qf1TestKeysetValue(labels)), entries(vectors.positiveEnv[name] ?? ''), name);
  }
});

test('every case that declares keysets declares the corpus keysets, and every secret read declares them', () => {
  const want = corpusKeysets(vectors);
  let declared = 0;
  for (const nc of corpus) {
    const where = `${nc.yamlBasename}: ${nc.raw.name}`;
    const got = caseKeysets(nc.raw);
    if (got.length > 0) {
      declared += 1;
      assert.deepEqual(Object.fromEntries(got.map((k) => [k.name, k.labels])), want, where);
    }
    if (keysRead(nc.raw).some((k) => secretKeys.has(k))) {
      assert.ok(got.length > 0, `${where} reads a qf1 secret without keysets:`);
    }
  }
  assert.ok(declared > 0, 'no case declares keysets');
});

test('every qf1 secret case expects what the vectors say a read returns', () => {
  let checked = 0;
  for (const nc of corpus) {
    const kase = nc.raw;
    const where = `${nc.yamlBasename}: ${kase.name}`;
    const expected = kase.expected ?? {};
    const input = kase.input ?? {};
    const key = input.key;
    if (typeof key === 'string' && secretKeys.has(key)) {
      const want = expectedSecretValue(vectors, key);
      const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default');
      if (want === null) {
        // A failing value: the default, the absent value, false or the mapped raise.
        if (expected.status === 'raise') assert.equal(expected.error, 'unable_to_decrypt', where);
        else if (hasDefault) assert.deepEqual(expected.value, input.default, where);
        else if (kase.function === 'enabled') assert.equal(expected.value, false, where);
        else assert.equal(expected.value ?? null, null, where);
      } else {
        assert.notEqual(expected.status, 'raise', where);
        assert.equal(expected.value, want, where);
      }
      checked += 1;
    }
    if (Array.isArray(kase.expected_data)) {
      for (const row of kase.expected_data as Array<Record<string, unknown>>) {
        if (typeof row.key !== 'string' || !secretKeys.has(row.key)) continue;
        assert.equal(row.type, 'SECRET', where);
        assert.equal(row.value, expectedSecretValue(vectors, row.key), where);
        assert.deepEqual(row.selected_value, { string: redactedValue(storedSecretValue(vectors, row.key)) }, where);
        checked += 1;
      }
    }
  }
  // Every secret fixture is read by at least one case.
  for (const key of secretKeys) {
    assert.ok(
      corpus.some((nc) => keysRead(nc.raw).includes(key)),
      `no case reads ${key}`,
    );
  }
  assert.ok(checked > 0);
});

test('keysets: rejects key material shapes it does not accept', () => {
  const base = { name: 'x' } as YamlCase;
  assert.throws(() => caseKeysets({ ...base, keysets: { HOME: ['a'] } } as YamlCase), /not a keyset name/);
  assert.throws(() => caseKeysets({ ...base, keysets: { 'QUONFIG_KEYSET_TEST\n': ['a'] } } as YamlCase), /not a keyset name/);
  assert.throws(() => caseKeysets({ ...base, keysets: { QUONFIG_KEYSET: [] } } as YamlCase), /non-empty list/);
  assert.throws(() => caseKeysets({ ...base, keysets: { QUONFIG_KEYSET: 'a' } } as unknown as YamlCase), /non-empty list/);
  assert.throws(
    () => caseKeysets({ ...base, env_vars: { QUONFIG_KEYSET: 'x' }, keysets: { QUONFIG_KEYSET: ['a'] } } as YamlCase),
    /also set in env_vars/,
  );
  assert.throws(() => rejectKeysets({ ...base, keysets: { QUONFIG_KEYSET: ['a'] } } as YamlCase, 'datadir'), /not supported/);
  assert.deepEqual(caseKeysets(base), []);
});

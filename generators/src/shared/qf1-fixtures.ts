// The qf1 fixtures of data/integration-tests, derived from
// tests/secrets/qf1-vectors.json (bead qfg-8seuf.3). Nothing here is
// hand-copied: every ciphertext and public key comes out of the vectors
// file, and `npm run qf1:sync` rewrites the fixture files from it.
// `npm run qf1:check` (and shared/qf1.test.ts) fails when a fixture on disk
// differs from what this module renders.
//
// tests/secrets/qf1-vectors.json is a byte-identical copy of
// project/plans/secrets-qf1/vectors.json (spec section 14). Refresh it with
// `npm run qf1:sync -- --from <path to project/plans/secrets-qf1/vectors.json>`;
// `npm run qf1:check -- --from <path>` fails if the copy has drifted.

import { createHash } from 'node:crypto';
import { QF1_BAD_KEYSET_NAME_FIXTURE, QF1_KEYSET_NAME, QF1_TEST_KEY_LABEL_PREFIX, qf1TestKeyEntry, qf1TestKeysetValue } from './qf1.js';

export const QF1_VECTORS_PATH = 'tests/secrets/qf1-vectors.json';
export const FIXTURE_ROOT = 'data/integration-tests';
export const ENVIRONMENT = 'Production';

// --- vectors.json shape (only the members used here) -----------------------

export interface Qf1Vectors {
  keysets: Array<{
    name: string;
    publicKeys: string[];
    keys: Array<{ label: string; privateKeyHex: string; privateKeyEntry: string; fingerprint: string }>;
  }>;
  positiveEnv: Record<string, string>;
  positive: Array<{ name: string; keyset: string; ciphertext: string; plaintext: string }>;
  negative: Array<{ name: string; ciphertext: string; env: Record<string, string>; expectedError: string; mustReject: boolean }>;
}

type VectorRef = { positive: string } | { negative: string };

/** The bad-keyset-name vector whose name the corpus env sets (see QF1_BAD_KEYSET_NAME_FIXTURE). */
const BAD_NAME_VECTOR = 'keyset-name-QUONFIG-KEYSETX';
const pos = (name: string): VectorRef => ({ positive: name });
const neg = (name: string): VectorRef => ({ negative: name });

export interface SecretFixture {
  key: string;
  /** The value of the default rule. */
  default: VectorRef;
  /** The value of the Production environment rule, when the doc has one. */
  production?: VectorRef;
  /** Why the fixture exists; for a failing one, why it fails in the corpus env. */
  note: string;
}

/**
 * The documents in data/integration-tests/secrets/. A fixture whose
 * Production value is a `positive` vector decrypts; one whose value is a
 * `negative` vector fails with the SDK's unable-to-decrypt error in the
 * corpus env (the keysets every case holds, see corpusKeysets()). ITD asserts
 * only that mapped error (spec decision 41); the qf1 error class is the SDK
 * unit tests' job, against the vectors.
 */
// `gitleaks:allow` on the key lines: generic-api-key reads `key: '<name>'`
// as a credential; these are config key names.
export const SECRET_FIXTURES: SecretFixture[] = [
  { key: 'qf1.secret.short', default: pos('short-ascii'), note: 'decrypts to "hello"' }, // gitleaks:allow
  { key: 'qf1.secret.empty', default: pos('empty-string'), note: 'the empty string is a valid secret' }, // gitleaks:allow
  { key: 'qf1.secret.multibyte', default: pos('multibyte-utf8'), note: '2-, 3- and 4-byte UTF-8' }, // gitleaks:allow
  { key: 'qf1.secret.leading.bom', default: pos('leading-bom-kept'), note: 'a leading U+FEFF is part of the value' }, // gitleaks:allow
  { key: 'qf1.secret.json.special', default: pos('json-special-chars'), note: 'quote, backslash, LF, tab, colon in the plaintext' }, // gitleaks:allow
  { key: 'qf1.secret.default.keyset', default: pos('bare-default-keyset'), note: 'the bare QUONFIG_KEYSET name' }, // gitleaks:allow
  {
    key: 'qf1.secret.older.key', // gitleaks:allow
    default: pos('two-key-keyset-older-key'),
    note: 'encrypted to the second key of a two-key keyset (after a rotation began)',
  },
  {
    key: 'qf1.secret.env.scoped', // gitleaks:allow
    default: pos('bare-default-keyset'),
    production: pos('two-key-keyset-write-key'),
    note: 'default rule on QUONFIG_KEYSET, Production rule on QUONFIG_KEYSET_TEST_PROD (spec 10.2)',
  },
  {
    key: 'qf1.secret.shadowed', // gitleaks:allow
    default: pos('short-ascii'),
    note: 'also in configs/ with an old decryptWith value; datadir mode loads secrets/ last, so this copy wins (spec 13.7)',
  },
  {
    key: 'qf1.secret.keyset.missing', // gitleaks:allow
    default: neg('tampered-header-keyset'),
    note: 'encrypted to QUONFIG_KEYSET_TEST_COPY, which no case ever sets: keyset_missing',
  },
  {
    key: 'qf1.secret.key.not.held', // gitleaks:allow
    default: neg('trial-decryption-unknown-fingerprint'),
    note: 'fingerprint 00000000 is not held (sealed to a held key; an SDK that tries every key decrypts it): key_not_held',
  },
  {
    key: 'qf1.secret.cross.keyset', // gitleaks:allow
    default: neg('cross-keyset-lookup'),
    note: 'sealed to the QUONFIG_KEYSET key under the header name QUONFIG_KEYSET_TEST (lookup is by keyset AND fingerprint): key_not_held',
  },
  {
    key: 'qf1.secret.tampered.header', // gitleaks:allow
    default: neg('tampered-header-fingerprint'),
    note: 'header fingerprint changed to another held key of the same keyset; the AAD no longer matches: decrypt_failed',
  },
  {
    key: 'qf1.secret.keyset.name.invalid', // gitleaks:allow
    default: neg(BAD_NAME_VECTOR),
    note:
      'keyset field QUONFIG_KEYSETX does not match ^QUONFIG_KEYSET(_[A-Z0-9]+)*$; no env var may be read: invalid_keyset_name. ' +
      'The corpus env sets QUONFIG_KEYSETX to the key it was sealed to, so a reader without the name rule decrypts it',
  },
  {
    key: 'qf1.secret.trailing.colon', // gitleaks:allow
    default: neg('trailing-colon'),
    note: 'a fifth, empty field (genuine tag; a lenient parser decrypts it): malformed',
  },
  {
    key: 'qf1.secret.low.order.ephemeral', // gitleaks:allow
    default: neg('ephemeral-low-order-u-0-order-2'),
    note: 'small-order ephemeral key, shared secret all zero, tag valid for S = 0: invalid_ephemeral_key',
  },
];

/**
 * Old-format documents in data/integration-tests/configs/ that the qf1 cases
 * need (spec 13.3 R1 and 13.7). Their ciphertext is the old `ct--iv--tag`
 * value that the removed a.secret.config fixture carried; `qf1.legacy.key`
 * holds the matching old key, so an OLD SDK decrypts both values to
 * "hello.world" and the cases fail if a new SDK still has the old path.
 */
const LEGACY_CIPHERTEXT = '875247386844c18c58a97c--b307b97a8288ac9da3ce0cf2--7ab0c32e044869e355586ed653a435de';
const LEGACY_KEY_CONFIG = 'qf1.legacy.key';
// The old integration-test key (the removed fixture
// prefab.secrets.encryption.key provided it from an env var). A test key: it
// protects nothing.
const LEGACY_KEY_HEX = 'c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221'; // gitleaks:allow

export interface LegacyFixture {
  key: string;
  value: Record<string, unknown>;
  note: string;
}

export const LEGACY_FIXTURES: LegacyFixture[] = [
  {
    key: 'qf1.secret.shadowed', // gitleaks:allow
    value: { type: 'string', value: LEGACY_CIPHERTEXT, confidential: true, decryptWith: LEGACY_KEY_CONFIG },
    note: 'the configs/ twin of secrets/qf1.secret.shadowed (side-by-side transition); never evaluated by a new SDK',
  },
  {
    key: 'qf1.legacy.decrypt.with', // gitleaks:allow
    value: { type: 'string', value: LEGACY_CIPHERTEXT, confidential: true, decryptWith: LEGACY_KEY_CONFIG },
    note: 'a decryptWith value with no secrets/ twin: a new SDK fails it (spec 13.3 R1, decision 30)',
  },
  {
    key: LEGACY_KEY_CONFIG,
    value: { type: 'string', value: LEGACY_KEY_HEX },
    note: 'the old key the two documents above name, so only a new SDK fails them',
  },
];

// --- lookups -----------------------------------------------------------------

function vectorFor(v: Qf1Vectors, ref: VectorRef): { ciphertext: string; plaintext: string | null } {
  if ('positive' in ref) {
    const p = v.positive.find((x) => x.name === ref.positive);
    if (!p) throw new Error(`qf1 vectors have no positive case ${ref.positive}`);
    return { ciphertext: p.ciphertext, plaintext: p.plaintext };
  }
  const n = v.negative.find((x) => x.name === ref.negative);
  if (!n) throw new Error(`qf1 vectors have no negative case ${ref.negative}`);
  return { ciphertext: n.ciphertext, plaintext: null };
}

/**
 * The keysets every case that reads a secret declares: each keyset of the
 * vectors with its keys' labels, in the vectors' order. This is the vectors'
 * positiveEnv, by label (the env value differs only in the whitespace and the
 * trailing comma positiveEnv adds, which the SDK unit tests cover).
 */
export function corpusKeysets(v: Qf1Vectors): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ks of v.keysets) out[ks.name] = ks.keys.map((k) => k.label);
  out[QF1_BAD_KEYSET_NAME_FIXTURE] = badNameLabels(v);
  return out;
}

/**
 * The labels of the keys the bad-name vector's env holds under
 * QUONFIG_KEYSETX (read from the vector, not hand-picked).
 */
function badNameLabels(v: Qf1Vectors): string[] {
  const n = v.negative.find((x) => x.name === BAD_NAME_VECTOR);
  if (!n) throw new Error(`qf1 vectors have no negative case ${BAD_NAME_VECTOR}`);
  const value = n.env[QF1_BAD_KEYSET_NAME_FIXTURE];
  if (value === undefined) throw new Error(`${BAD_NAME_VECTOR}: env has no ${QF1_BAD_KEYSET_NAME_FIXTURE}`);
  const entries = value.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
  const labels = entries.map((e) => {
    const k = v.keysets.flatMap((ks) => ks.keys).find((key) => key.privateKeyEntry === e);
    if (!k) throw new Error(`${BAD_NAME_VECTOR}: ${QF1_BAD_KEYSET_NAME_FIXTURE} holds a key no vectors keyset describes`);
    return k.label;
  });
  if (qf1TestKeysetValue(labels) !== value) {
    throw new Error(`${BAD_NAME_VECTOR}: ${QF1_BAD_KEYSET_NAME_FIXTURE} is not exactly the derived entries of ${labels.join(', ')}`);
  }
  if (n.ciphertext.split(':')[1] !== QF1_BAD_KEYSET_NAME_FIXTURE) {
    throw new Error(`${BAD_NAME_VECTOR}: its keyset field is not ${QF1_BAD_KEYSET_NAME_FIXTURE}`);
  }
  return labels;
}

/** What a read of `key` returns in Production in the corpus env: the plaintext, or null (fails). */
export function expectedSecretValue(v: Qf1Vectors, key: string): string | null {
  const f = SECRET_FIXTURES.find((x) => x.key === key);
  if (!f) throw new Error(`${key} is not a qf1 secret fixture`);
  return vectorFor(v, f.production ?? f.default).plaintext;
}

/** The stored ciphertext a read of `key` in Production uses. */
export function storedSecretValue(v: Qf1Vectors, key: string): string {
  const f = SECRET_FIXTURES.find((x) => x.key === key);
  if (!f) throw new Error(`${key} is not a qf1 secret fixture`);
  return vectorFor(v, f.production ?? f.default).ciphertext;
}

/** Telemetry redaction of a confidential value: "*****" + first 5 hex of md5(stored value). */
export function redactedValue(stored: string): string {
  return '*****' + createHash('md5').update(stored, 'utf8').digest('hex').slice(0, 5);
}

// --- consistency of the vectors themselves -------------------------------------

/**
 * Throws unless every test key in the vectors is the label derivation the
 * generated helpers implement, and the negative vectors the fixtures use
 * still fail in the corpus env for the reason the fixture notes give.
 */
export function checkVectors(v: Qf1Vectors): void {
  for (const ks of v.keysets) {
    if (!QF1_KEYSET_NAME.test(ks.name)) throw new Error(`vectors keyset ${ks.name} is not a keyset name`);
    for (const k of ks.keys) {
      const hex = createHash('sha256').update(QF1_TEST_KEY_LABEL_PREFIX + k.label, 'utf8').digest('hex');
      if (hex !== k.privateKeyHex) {
        throw new Error(`vectors key ${k.label}: privateKeyHex is not sha256("${QF1_TEST_KEY_LABEL_PREFIX}${k.label}")`);
      }
      if (qf1TestKeyEntry(k.label) !== k.privateKeyEntry) {
        throw new Error(`vectors key ${k.label}: privateKeyEntry differs from the label derivation`);
      }
    }
  }
  const held = new Set(Object.keys(corpusKeysets(v)));
  for (const name of Object.keys(v.positiveEnv)) {
    if (!held.has(name)) throw new Error(`positiveEnv sets ${name}, which no vectors keyset describes`);
  }
  const missing = SECRET_FIXTURES.find((f) => f.key === 'qf1.secret.keyset.missing')!;
  const ct = vectorFor(v, missing.default).ciphertext;
  const ksName = ct.split(':')[1] ?? '';
  if (held.has(ksName)) throw new Error(`qf1.secret.keyset.missing uses ${ksName}, which the corpus env holds`);
}

// --- rendering ------------------------------------------------------------------

function rule(value: Record<string, unknown>): Record<string, unknown> {
  return { criteria: [{ operator: 'ALWAYS_TRUE' }], value };
}

function secretValue(ciphertext: string): Record<string, unknown> {
  return { type: 'string', value: ciphertext, confidential: true };
}

// Deterministic ids in the style of the other fixtures (a fixed prefix plus
// the fixture's position), so a re-render is byte-identical.
function fixtureId(n: number): string {
  return `1764000000000${String(n).padStart(4, '0')}`;
}

function json(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Every file the vectors determine, keyed by path relative to the repo root:
 * data/integration-tests/secrets/*.json, the qf1 documents in configs/, and
 * data/integration-tests/quonfig.json (secrets.keysets from the vectors'
 * public keys).
 */
export function renderQf1Fixtures(v: Qf1Vectors): Map<string, string> {
  checkVectors(v);
  const files = new Map<string, string>();
  let n = 0;
  for (const f of SECRET_FIXTURES) {
    n += 1;
    const doc: Record<string, unknown> = {
      id: fixtureId(n),
      projectId: '124',
      key: f.key,
      type: 'secret',
      valueType: 'string',
      sendToClientSdk: false,
      default: { rules: [rule(secretValue(vectorFor(v, f.default).ciphertext))] },
    };
    if (f.production) {
      doc.environments = [{ id: ENVIRONMENT, rules: [rule(secretValue(vectorFor(v, f.production).ciphertext))] }];
    }
    files.set(`${FIXTURE_ROOT}/secrets/${f.key}.json`, json(doc));
  }
  for (const f of LEGACY_FIXTURES) {
    n += 1;
    const doc = {
      id: fixtureId(n),
      projectId: '124',
      key: f.key,
      type: 'config',
      valueType: 'string',
      sendToClientSdk: false,
      default: { rules: [rule(f.value)] },
    };
    files.set(`${FIXTURE_ROOT}/configs/${f.key}.json`, json(doc));
  }
  const keysets: Record<string, { publicKeys: string[] }> = {};
  for (const ks of v.keysets) keysets[ks.name] = { publicKeys: ks.publicKeys };
  files.set(`${FIXTURE_ROOT}/quonfig.json`, json({ environments: [ENVIRONMENT], secrets: { keysets } }));
  return files;
}

/** Every qf1 fixture key, secrets/ and configs/. */
export function qf1FixtureKeys(): { secrets: string[]; configs: string[] } {
  return { secrets: SECRET_FIXTURES.map((f) => f.key), configs: LEGACY_FIXTURES.map((f) => f.key) };
}

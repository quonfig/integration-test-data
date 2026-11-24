// qf1 secrets in the eval corpus (bead qfg-8seuf.3; format:
// project/plans/secrets-qf1-spec.md).
//
// A case that reads a secret declares the keysets its environment holds:
//
//   keysets:
//     QUONFIG_KEYSET_TEST: ["QUONFIG_KEYSET_TEST/1"]
//
// Each entry is an env var name (spec section 2) mapped to test-key LABELS,
// never to key material. Every test key in tests/secrets/qf1-vectors.json is
// derived from its label:
//
//   privateKey = SHA-256("qf1 test vector private key: " + label)   (32 bytes)
//   entry      = "qf1-priv-" + base64url-no-pad(privateKey)
//
// so each generator emits a small helper (qf1TestKeyset and its spellings)
// that derives the entries at test run time and joins them with commas, the
// env var format of spec 6.2. The env var is set for the case the same way
// `env_vars` are. No private entry is written into this repo's YAML or into
// any SDK's generated tests, so neither trips the secret scanners
// (gitleaks' default rules flag `QUONFIG_KEYSET_X = "qf1-priv-..."`, and the
// qf1-priv- rule flags every entry).
//
// The keyset values must be the SAME in every case of the corpus (shared/
// qf1.test.ts checks it): spec 6.2 lets an SDK cache a parsed keyset for the
// life of the process, and some harnesses share one client across cases, so a
// case that changed a keyset's value would see another case's cached parse.
// A "keyset missing" case therefore uses a keyset name no case ever sets.

import { createHash } from 'node:crypto';
import type { YamlCase } from '../types.js';

export const QF1_TEST_KEY_LABEL_PREFIX = 'qf1 test vector private key: ';

/** Spec section 2, as a full-string match (JS `$` without /m never matches before a final LF). */
export const QF1_KEYSET_NAME = /^QUONFIG_KEYSET(?:_[A-Z0-9]+)*$/;

export interface CaseKeyset {
  /** The env var name, e.g. QUONFIG_KEYSET_TEST. */
  name: string;
  /** Test-key labels, in env order. */
  labels: string[];
}

/** The private key entry for a test-key label (spec 6.1). */
export function qf1TestKeyEntry(label: string): string {
  const priv = createHash('sha256').update(QF1_TEST_KEY_LABEL_PREFIX + label, 'utf8').digest();
  return 'qf1-priv-' + priv.toString('base64url');
}

/** The env var value the generated helper produces for `labels`. */
export function qf1TestKeysetValue(labels: string[]): string {
  return labels.map(qf1TestKeyEntry).join(',');
}

/**
 * A case's `keysets:` block, validated and sorted by name. `[]` when the case
 * has none. Throws on a malformed block, on a keyset name outside spec 2 and
 * on a name the case also sets through `env_vars`.
 */
export function caseKeysets(kase: YamlCase): CaseKeyset[] {
  const raw = (kase as { keysets?: unknown }).keysets;
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('keysets must be a map of keyset name to a list of test-key labels');
  }
  const envVars = kase.env_vars ?? {};
  const out: CaseKeyset[] = [];
  for (const [name, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (!QF1_KEYSET_NAME.test(name)) {
      throw new Error(`keysets: ${JSON.stringify(name)} is not a keyset name (^QUONFIG_KEYSET(_[A-Z0-9]+)*$)`);
    }
    if (Object.prototype.hasOwnProperty.call(envVars, name)) {
      throw new Error(`keysets: ${name} is also set in env_vars`);
    }
    if (!Array.isArray(labels) || labels.length === 0 || labels.some((l) => typeof l !== 'string' || l.length === 0)) {
      throw new Error(`keysets.${name} must be a non-empty list of test-key labels`);
    }
    out.push({ name, labels: labels as string[] });
  }
  if (out.length === 0) throw new Error('keysets must name at least one keyset');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** True iff the case declares `keysets:`. */
export function hasKeysets(kase: YamlCase): boolean {
  return caseKeysets(kase).length > 0;
}

/**
 * `keysets:` is honoured on eval (get / get_or_raise / enabled) and
 * telemetry cases. Every other case shape calls this so a stray block fails
 * the generator instead of being dropped.
 */
export function rejectKeysets(kase: YamlCase, where: string): void {
  if ((kase as { keysets?: unknown }).keysets !== undefined) {
    throw new Error(`keysets: is not supported on ${where} cases`);
  }
}

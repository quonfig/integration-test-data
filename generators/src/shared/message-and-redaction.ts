// Shared parsing for two T1 expectation shapes (qfg-goi1.10.11):
//
//   expected.message_contains / expected.message_excludes (raise cases):
//     the raised error's message must contain the string (or every string
//     in a list) and must contain none of the excluded substrings. Used to
//     pin the ENV_VAR coercion template and to prove the env value never
//     reaches the message.
//
//   selected_value: { redacted: true } (evaluation_summary expected rows):
//     the counter's selectedValue must be exactly {string: "*****<5 hex>"},
//     the redaction shape, without pinning the hash input. Targets check the
//     wire value against REDACTED_SELECTED_VALUE_PATTERN and then compare
//     the rest of the row exactly as usual.
//
// Every target MUST honour both or fail the generator; silently dropping
// them would turn a leak check into a vacuous pass.

import type { CaseExpected } from '../types.js';

export interface MessageExpectations {
  contains: string[];
  excludes: string[];
}

function stringList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0 || list.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new Error(`expected.${field} must be a non-empty string or list of non-empty strings`);
  }
  return list as string[];
}

/** Parse message_contains / message_excludes; both empty when absent. */
export function messageExpectations(expected: CaseExpected | undefined): MessageExpectations {
  const e = expected ?? {};
  const out = {
    contains: stringList(e.message_contains, 'message_contains'),
    excludes: stringList(e.message_excludes, 'message_excludes'),
  };
  if ((out.contains.length > 0 || out.excludes.length > 0) && e.status !== 'raise') {
    throw new Error('expected.message_contains/message_excludes are only valid on status: raise cases');
  }
  return out;
}

/** Regex source the redacted selectedValue string must match in full. */
export const REDACTED_SELECTED_VALUE_PATTERN = '^\\*{5}[0-9a-f]{5}$';

/** True when a YAML selected_value is the {redacted: true} matcher. */
export function isRedactedMatcher(sv: unknown): boolean {
  if (!sv || typeof sv !== 'object' || Array.isArray(sv)) return false;
  const o = sv as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, 'redacted')) return false;
  if (o.redacted !== true || Object.keys(o).length !== 1) {
    throw new Error('selected_value.redacted must be exactly {redacted: true}');
  }
  return true;
}

/**
 * Keys of evaluation_summary expected rows whose selected_value is the
 * {redacted: true} matcher. A key may appear on one matcher row only.
 */
export function redactedRowKeys(expectedData: unknown): string[] {
  if (!Array.isArray(expectedData)) return [];
  const keys: string[] = [];
  for (const row of expectedData) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (!isRedactedMatcher(r.selected_value)) continue;
    if (typeof r.key !== 'string' || r.key.length === 0) {
      throw new Error('a selected_value {redacted: true} row needs a key');
    }
    if (keys.includes(r.key)) {
      throw new Error(`more than one {redacted: true} row for key ${r.key}`);
    }
    keys.push(r.key);
  }
  return keys;
}

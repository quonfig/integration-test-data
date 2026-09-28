// `repeat` + `expected.values_seen` (qfg-t9wo).
//
// A case carrying `repeat: N` and `expected.values_seen: [...]` asserts a
// NON-deterministic evaluation: the generated test evaluates the flag N
// times with the case's contexts and asserts that the SET of values
// returned equals `values_seen` exactly (order-free). Used for weighted
// rollouts with no `hashByPropertyName`, which pick a random variant on
// every evaluation.
//
// Every target calls `repeatSpec()` BEFORE its normal single-value path so
// a `values_seen` case can never silently degrade into a single-value
// assertion (or into "case has no expected.value"). A target that cannot
// render the spec for a given type must throw.

import type { YamlCase } from '../types.js';

export interface RepeatSpec {
  repeat: number;
  valuesSeen: Array<string | number | boolean>;
}

/**
 * Returns the validated spec when the case uses `repeat`/`values_seen`,
 * `null` when it uses neither. Throws on any half-specified or malformed
 * combination.
 */
export function repeatSpec(kase: YamlCase): RepeatSpec | null {
  const expected = (kase.expected ?? {}) as Record<string, unknown>;
  const hasRepeat = Object.prototype.hasOwnProperty.call(kase, 'repeat');
  const hasSeen = Object.prototype.hasOwnProperty.call(expected, 'values_seen');

  if (!hasRepeat && !hasSeen) return null;
  if (hasRepeat !== hasSeen) {
    throw new Error('`repeat` and `expected.values_seen` must be used together');
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'value')) {
    throw new Error('`expected.values_seen` is mutually exclusive with `expected.value`');
  }
  if (expected.status === 'raise') {
    throw new Error('`expected.values_seen` cannot be combined with `status: raise`');
  }

  const repeat = kase.repeat;
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1) {
    throw new Error(`\`repeat\` must be a positive integer, got ${JSON.stringify(repeat)}`);
  }

  const seen = expected.values_seen;
  if (!Array.isArray(seen) || seen.length === 0) {
    throw new Error('`expected.values_seen` must be a non-empty list');
  }
  for (const v of seen) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(
        `\`expected.values_seen\` elements must be scalars, got ${JSON.stringify(v)}`,
      );
    }
  }
  if (new Set(seen.map((v) => JSON.stringify(v))).size !== seen.length) {
    throw new Error('`expected.values_seen` must not contain duplicates');
  }
  if (seen.length > repeat) {
    throw new Error('`expected.values_seen` has more values than `repeat` evaluations');
  }

  return { repeat, valuesSeen: seen as Array<string | number | boolean> };
}

/**
 * Checks the case's `type` against the spec's values. Only INT and STRING
 * are supported for now (the only shapes the YAML uses); anything else
 * throws so a new YAML shape forces a generator change.
 */
export function repeatValueType(kase: YamlCase, spec: RepeatSpec): 'INT' | 'STRING' {
  const t = (kase.type ?? '').toString().toUpperCase();
  if (t === 'INT') {
    for (const v of spec.valuesSeen) {
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new Error(`INT type but values_seen element is not an integer: ${JSON.stringify(v)}`);
      }
    }
    return 'INT';
  }
  if (t === 'STRING') {
    for (const v of spec.valuesSeen) {
      if (typeof v !== 'string') {
        throw new Error(`STRING type but values_seen element is not a string: ${JSON.stringify(v)}`);
      }
    }
    return 'STRING';
  }
  throw new Error(`\`expected.values_seen\` is only supported for INT and STRING types, got ${JSON.stringify(t)}`);
}

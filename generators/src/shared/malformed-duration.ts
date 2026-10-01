// Malformed-DURATION cases (qfg-2agi.6, .7). Plan
// project/plans/2026-10-01-duration-validity.md decision 3: a typed getter
// WITH a default returns the default AND its Details report Reason=ERROR.
//
// The corpus names every malformed-duration fixture `*.duration.malformed.*`
// (stored `test.duration.malformed.<v>`, ENV_VAR `provided.duration.malformed.<v>`).
// A DURATION case that carries a default is only meaningful for those keys;
// any other shape fails the generator so a Details reason is never silently
// left unasserted.

const MALFORMED_KEY = /(^|\.)duration\.malformed\./;

/**
 * True when `kase` is a malformed-duration case read with a default, i.e. the
 * Details call must report the default value with Reason=ERROR. Throws for a
 * DURATION-with-default case on a key that is not a malformed fixture.
 */
export function isMalformedDurationWithDefault(
  yamlType: string,
  key: string,
  input: Record<string, unknown>,
  expectedMillis: unknown,
): boolean {
  if (yamlType !== 'DURATION') return false;
  if (!Object.prototype.hasOwnProperty.call(input, 'default')) return false;
  if (!MALFORMED_KEY.test(key)) {
    throw new Error(
      `DURATION case with a default on non-malformed key "${key}": no Details reason ` +
        `contract is defined for this shape (see shared/malformed-duration.ts)`,
    );
  }
  if (expectedMillis !== input.default) {
    throw new Error(
      `malformed DURATION case "${key}" must expect its default (${String(input.default)}), ` +
        `got expected.millis=${String(expectedMillis)}`,
    );
  }
  return true;
}

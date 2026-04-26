// Sanitize a YAML test `name` into a target-specific identifier. The
// suffix is appended to the language's test method name, so it MUST be
// stable across regenerations and unique within a suite.
//
// New target? Add a function below — same shape as `rubyMethodSuffix`.

function sanitize(name: string): string {
  let s = (name ?? '').toString().toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '_');
  s = s.replace(/_+/g, '_');
  s = s.replace(/^_/, '').replace(/_$/, '');
  return s;
}

/** Ruby Minitest method suffix — `def test_<suffix>`. */
export function rubyMethodSuffix(name: string): string {
  const s = sanitize(name);
  return s.length > 0 ? s : 'unnamed';
}

/**
 * Disambiguate duplicates within a suite. `seen` is mutated to track counts.
 * Returns a unique suffix; first occurrence is unsuffixed.
 */
export function uniqueSuffix(seen: Map<string, number>, suffix: string): string {
  const count = (seen.get(suffix) ?? 0) + 1;
  seen.set(suffix, count);
  return count > 1 ? `${suffix}_${count}` : suffix;
}

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

/**
 * Go test function name suffix — `func Test<Suite>_<suffix>(t *testing.T)`.
 *
 * Converts the YAML `name` into a CamelCase identifier:
 *   "list on left side test (1)"  → "ListOnLeftSideTest1"
 *   "duration 1.5M"               → "Duration15M"
 *   "raises an error if the client doesn't init"
 *                                 → "RaisesAnErrorIfTheClientDoesntInit"
 *
 * Stable across regenerations (deterministic), unique within a suite when
 * passed through {@link uniqueGoSuffix}.
 */
export function goTestFunctionName(name: string): string {
  const raw = (name ?? '').toString();
  // Split on any run of non-alphanumeric chars; tokens are then capitalized
  // and joined, so "1.5M" → ["1", "5M"] → "15M" — adjacent digits/letters
  // render as one CamelCase chunk.
  const parts = raw.split(/[^a-zA-Z0-9]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return 'Unnamed';
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Disambiguate Go duplicates. Uses a `_2`, `_3` suffix on the second+
 * occurrence so generated names round-trip stably. First occurrence is bare.
 */
export function uniqueGoSuffix(seen: Map<string, number>, name: string): string {
  const count = (seen.get(name) ?? 0) + 1;
  seen.set(name, count);
  return count > 1 ? `${name}_${count}` : name;
}

/**
 * Convert a YAML basename ("get.yaml", "datadir_environment.yaml") into the
 * Go suite identifier ("Get", "DatadirEnvironment"). Used as the leading
 * component of `Test<Suite>_<Case>`.
 */
export function goSuiteName(yamlBasename: string): string {
  const stem = yamlBasename.endsWith('.yaml')
    ? yamlBasename.slice(0, -'.yaml'.length)
    : yamlBasename;
  return stem
    .split(/[^a-zA-Z0-9]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

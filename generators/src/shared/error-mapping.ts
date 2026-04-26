// Map YAML `expected.error` strings to per-target error class names.
// Adding a target = adding a key; missing entries indicate an unmapped
// error and the generator MUST fail loudly rather than emit a skip.

export type TargetName = 'ruby' | 'go' | 'node' | 'python';

export type ErrorMap = Readonly<Record<string, string>>;

const RUBY_ERRORS: ErrorMap = {
  missing_default: 'Quonfig::Errors::MissingDefaultError',
  initialization_timeout: 'Quonfig::Errors::InitializationTimeoutError',
  missing_env_var: 'Quonfig::Errors::MissingEnvVarError',
  unable_to_coerce_env_var: 'Quonfig::Errors::EnvVarParseError',
  unable_to_decrypt: 'Quonfig::Errors::DecryptionError',
  missing_environment: 'Quonfig::Errors::MissingEnvironmentError',
  invalid_environment: 'Quonfig::Errors::InvalidEnvironmentError',
};

// Node SDK currently raises plain `Error` instances for nearly every
// failure path (env-var lookups, type coercion, decryption, datadir
// init, etc). Mapping every YAML error key to "Error" is the truthful
// reflection of today's surface area; a follow-up will refine these
// once the SDK adds dedicated error classes.
const NODE_ERRORS: ErrorMap = {
  missing_default: 'Error',
  initialization_timeout: 'Error',
  missing_env_var: 'Error',
  unable_to_coerce_env_var: 'Error',
  unable_to_decrypt: 'Error',
  missing_environment: 'Error',
  invalid_environment: 'Error',
};

// Python SDK exceptions live in `quonfig.exceptions`. The mapping below
// reflects the actual exception classes raised today (see
// sdk-python/quonfig/exceptions.py). `unable_to_coerce_env_var` does not
// have a dedicated class — the SDK raises QuonfigKeyNotFoundError when a
// provided env var fails type coercion. `initialization_timeout` maps to
// the dedicated QuonfigInitTimeoutError so the generated test asserts the
// real surface (no skipping). The datadir init errors (missing/invalid
// environment) currently surface as RuntimeError.
const PYTHON_ERRORS: ErrorMap = {
  missing_default: 'QuonfigKeyNotFoundError',
  initialization_timeout: 'QuonfigInitTimeoutError',
  missing_env_var: 'QuonfigEnvVarNotSetError',
  unable_to_coerce_env_var: 'QuonfigKeyNotFoundError',
  unable_to_decrypt: 'QuonfigDecryptionError',
  missing_environment: 'RuntimeError',
  invalid_environment: 'RuntimeError',
};

// Go SDK errors live in package `quonfig`. The map covers the error keys
// used by the YAML cases that drive real-Client construction; resolver-time
// raise paths still go through assertResolveError in test_helpers_test.go.
// missing_default has no dedicated Go error type (the SDK returns
// (zero, false, nil)); the helper bridges that by checking ok=false.
const GO_ERRORS: ErrorMap = {
  initialization_timeout: 'quonfig.ErrInitializationTimeout',
  missing_env_var: 'quonfig.ErrMissingEnvVar',
};

const ERROR_MAPS: Record<TargetName, ErrorMap> = {
  ruby: RUBY_ERRORS,
  node: NODE_ERRORS,
  python: PYTHON_ERRORS,
  go: GO_ERRORS,
};

export function lookupErrorClass(target: TargetName, errorKey: string): string | undefined {
  const map = ERROR_MAPS[target];
  return map[errorKey];
}

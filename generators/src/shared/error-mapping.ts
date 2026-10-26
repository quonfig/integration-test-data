// Map YAML `expected.error` strings to per-target error class names.
// Adding a target = adding a key; missing entries indicate an unmapped
// error and the generator MUST fail loudly rather than emit a skip.

export type TargetName = 'ruby' | 'go' | 'node' | 'python' | 'java' | 'dotnet';

export type ErrorMap = Readonly<Record<string, string>>;

const RUBY_ERRORS: ErrorMap = {
  missing_default: 'Quonfig::Errors::MissingDefaultError',
  initialization_timeout: 'Quonfig::Errors::InitializationTimeoutError',
  missing_env_var: 'Quonfig::Errors::MissingEnvVarError',
  unable_to_coerce_env_var: 'Quonfig::Errors::EnvVarParseError',
  unable_to_decrypt: 'Quonfig::Errors::DecryptionError',
  // Typed-getter contract (qfg-zvyy): a wrong-type read in get_or_raise.
  type_mismatch: 'Quonfig::Errors::TypeMismatchError',
  missing_environment: 'Quonfig::Errors::MissingEnvironmentError',
  invalid_environment: 'Quonfig::Errors::InvalidEnvironmentError',
};

// sdk-node raises plain `Error` instances for every one of these failure
// paths (it exports no dedicated error classes), so `toThrow(Error)` would
// accept ANY failure -- a malformed-value raise would be indistinguishable
// from a missing env var. Each key therefore maps to a vitest `toThrow`
// matcher: a RegExp literal over the stable message sdk-node emits for that
// path (see sdk-node src/quonfig.ts, resolver.ts, encryption.ts, datadir.ts).
// The value is emitted verbatim into generated code.
const NODE_ERRORS: ErrorMap = {
  // quonfig.ts handleNoDefault (onNoDefault: "error").
  missing_default: '/^No value found for key "/',
  // quonfig.ts init() timeout race.
  initialization_timeout: '/^Initialization timed out$/',
  // resolver.ts ENV_VAR lookup.
  missing_env_var: '/^Environment variable ".*" not set for config "/',
  // resolver.ts coerceValue (int/double) for env vars, and the malformed
  // stored-value raise (typedRead.ts) for stored ints, doubles and durations
  // (plan 2026-10-01-duration-validity decision 3: one coercion error, any
  // source; qfg-zvyy extends it to stored int/double).
  // The ENV_VAR form is the cross-SDK template pinned in ITD T1
  // (qfg-goi1.10.11; sdk-go 4178377, sdk-net 0402468): it names the env var,
  // the type and the config, never the value. The old
  // `Cannot convert "<value>" to int` form leaked the value and no longer
  // matches.
  unable_to_coerce_env_var:
    '/^(environment variable ".*" cannot be converted to (int|double|duration) for config ".*"|\\[quonfig\\] Config ".*" has a malformed (int|double|duration) value)$/',
  // encryption.ts decrypt() / node:crypto GCM auth failure.
  unable_to_decrypt: '/^(Invalid key length|Invalid encrypted string|Unsupported state or unable to authenticate data)/',
  // Typed-getter contract (qfg-zvyy): the message the *Details API already
  // reports for TYPE_MISMATCH (quonfig.ts detailsFor), now also raised by the
  // typed getters under onNoDefault: "error".
  type_mismatch: '/^Config ".*" has type .*, expected .*$/',
  // datadir.ts resolveEnvironment.
  missing_environment: '/Environment required for datadir mode/',
  invalid_environment: '/Environment ".*" not found in workspace/',
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
  // Typed-getter contract (qfg-zvyy). Does not exist yet: sdk-python 3.0
  // adds it (QuonfigValueTypeError means a malformed wire payload, not this).
  type_mismatch: 'QuonfigTypeMismatchError',
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

// sdk-java exception classes will live under com.quonfig.sdk.exceptions.
// They don't exist yet (epic qfg-oi0j is in flight). Generated tests reference
// these fully-qualified class names; compile errors at sdk-java build time are
// the desired surfacing — they tell the SDK author exactly which exception
// class to add. Mapping mirrors the Python target's coverage.
const JAVA_ERRORS: ErrorMap = {
  missing_default: 'com.quonfig.sdk.exceptions.QuonfigKeyNotFoundException',
  initialization_timeout: 'com.quonfig.sdk.exceptions.QuonfigInitTimeoutException',
  missing_env_var: 'com.quonfig.sdk.exceptions.QuonfigEnvVarNotSetException',
  // qfg-koj9 (sdk-java 2.2.0): a subclass of QuonfigKeyNotFoundException, which
  // sdk-java threw for this case before 2.2.0 ("no value found" although the key
  // exists). Asserting the subclass is what lets the suite fail on the old type.
  unable_to_coerce_env_var: 'com.quonfig.sdk.exceptions.QuonfigCoercionException',
  unable_to_decrypt: 'com.quonfig.sdk.exceptions.QuonfigDecryptionException',
  // Typed-getter contract (qfg-zvyy). Added by qfg-koj9 as a subclass of the
  // IllegalArgumentException get*OrThrow throws today.
  type_mismatch: 'com.quonfig.sdk.exceptions.QuonfigTypeMismatchException',
  missing_environment: 'java.lang.RuntimeException',
  invalid_environment: 'java.lang.RuntimeException',
};

// sdk-net exception classes will live under Quonfig.Sdk.Exceptions.
// They don't exist yet (epic qfg-zp7i is in flight). Generated tests reference
// these fully-qualified class names; compile errors at sdk-net build time are
// the desired surfacing — they tell the SDK author exactly which exception
// class to add. Mapping mirrors the Java target's coverage.
const DOTNET_ERRORS: ErrorMap = {
  missing_default: 'Quonfig.Sdk.Exceptions.QuonfigKeyNotFoundException',
  initialization_timeout: 'Quonfig.Sdk.Exceptions.QuonfigInitTimeoutException',
  missing_env_var: 'Quonfig.Sdk.Exceptions.QuonfigEnvVarNotSetException',
  unable_to_decrypt: 'Quonfig.Sdk.Exceptions.QuonfigDecryptionException',
  missing_environment: 'System.InvalidOperationException',
  invalid_environment: 'System.InvalidOperationException',
};

const ERROR_MAPS: Record<TargetName, ErrorMap> = {
  ruby: RUBY_ERRORS,
  node: NODE_ERRORS,
  python: PYTHON_ERRORS,
  go: GO_ERRORS,
  java: JAVA_ERRORS,
  dotnet: DOTNET_ERRORS,
};

export function lookupErrorClass(target: TargetName, errorKey: string): string | undefined {
  const map = ERROR_MAPS[target];
  return map[errorKey];
}

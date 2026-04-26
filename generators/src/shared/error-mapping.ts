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

const ERROR_MAPS: Record<TargetName, ErrorMap> = {
  ruby: RUBY_ERRORS,
  node: NODE_ERRORS,
  // Other targets will be filled in by follow-up agents.
  go: {},
  python: {},
};

export function lookupErrorClass(target: TargetName, errorKey: string): string | undefined {
  const map = ERROR_MAPS[target];
  return map[errorKey];
}

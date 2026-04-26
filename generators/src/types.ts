// TypeScript shape for the cross-SDK YAML schema under
// integration-test-data/tests/eval/*.yaml. Only fields actually used by the
// generator are typed — anything else is left open so future YAML additions
// don't immediately break parsing.

export type ContextProps = Record<string, unknown>;
export type ContextTypes = Record<string, ContextProps>;

export interface CaseContexts {
  global?: ContextTypes;
  block?: ContextTypes;
  local?: ContextTypes;
}

export interface CaseInput {
  key?: string;
  flag?: string;
  default?: unknown;
  // some cases include other input fields (e.g. context). We don't enumerate.
  [k: string]: unknown;
}

export interface CaseExpected {
  status?: string; // e.g. "raise"
  error?: string; // e.g. "missing_default", "initialization_timeout"
  message?: string;
  value?: unknown;
  millis?: number; // duration cases
  [k: string]: unknown;
}

export interface ClientOverrides {
  on_no_default?: number;
  datadir?: string;
  environment?: string;
  initialization_timeout_sec?: number;
  on_init_failure?: string;
  prefab_api_url?: string;
  context_upload_mode?: string;
  collect_evaluation_summaries?: boolean;
  [k: string]: unknown;
}

export interface YamlCase {
  name: string;
  client?: string;
  function?: string;
  type?: string;
  input?: CaseInput;
  contexts?: CaseContexts;
  expected?: CaseExpected;
  client_overrides?: ClientOverrides;
  env_vars?: Record<string, string>;

  // post.yaml / telemetry.yaml use a different shape:
  aggregator?: string;
  endpoint?: string;
  data?: unknown;
  expected_data?: unknown;

  [k: string]: unknown;
}

export interface YamlGroup {
  name?: string;
  cases?: YamlCase[];
}

export interface YamlDoc {
  function?: string;
  tests?: YamlGroup[];
  [k: string]: unknown;
}

// A normalized case carries a reference to its origin (file + group) so
// generators can produce informative error messages and skip nothing.
export interface NormalizedCase {
  yamlBasename: string; // e.g. "get.yaml"
  groupName?: string; // YAML group `name`, if any
  raw: YamlCase;
}

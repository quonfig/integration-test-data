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
  // raw_value_type: datadir_value_type.yaml only. When set to "number" the
  // generator emits — in addition to the normal value assertion — an
  // assertion that the LOADED config envelope's raw Value for the key is a
  // real number, not a string. Honored ONLY inside the datadir render
  // branch; a server-mode case carrying it is a generator error.
  raw_value_type?: string;
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

// delivery_environment.yaml: the literal HTTP/SSE wire shape api-delivery
// emits in SDK-key mode. The generator serializes `envelope` to JSON verbatim
// and stands up a mock `/api/v2/configs` returning it, so the fields are kept
// open (Record) — the wire JSON passes straight through, no per-field typing.
export interface DeliveryEnvelopeMeta {
  version?: string;
  environment?: string;
  [k: string]: unknown;
}

export interface DeliveryEnvelope {
  meta: DeliveryEnvelopeMeta;
  configs: Array<Record<string, unknown>>;
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

  // delivery_environment.yaml: literal wire-shape envelope returned by the
  // mock `/api/v2/configs` server. Present only on `mode: http_wire` cases.
  envelope?: DeliveryEnvelope;

  [k: string]: unknown;
}

export interface YamlGroup {
  name?: string;
  cases?: YamlCase[];
}

export interface YamlDoc {
  function?: string;
  // delivery_environment.yaml carries a top-level `mode: http_wire` marker.
  mode?: string;
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

# integration-test-data

Shared test definitions and config data for all Quonfig SDKs. Every SDK generates idiomatic tests from these YAML definitions to guarantee behavioral consistency across languages.

## Versions and changelog

SDKs pin a tag (`vYYYY.MM.DD[.N]`) in CI, never `main`. What changed in each
tag is in [CHANGELOG.md](CHANGELOG.md); how to cut a tag and how SDKs bump
their pin is in [RELEASING.md](RELEASING.md).

## Directory Structure

```
integration-test-data/
├── tests/
│   ├── eval/                    # Evaluation + telemetry YAML cases (one file per function)
│   ├── duration/grammar.yaml    # Shared ISO-8601 duration grammar
│   ├── regex/dialect.yaml       # Quonfig regex v1 writer fixture
│   └── openfeature/             # OpenFeature provider cases
├── data/
│   └── integration-tests/       # The workspace the cases evaluate against
│       ├── quonfig.json         # Lists valid environments
│       ├── configs/
│       ├── feature-flags/
│       ├── log-levels/
│       ├── segments/
│       └── schemas/
├── generators/                  # Turns the YAML into each SDK's tests (one target per SDK)
├── chaos/                       # Cross-SDK network-chaos harness + supervisor contract; see chaos/README.md
├── verify-sdk-boot/             # Per-SDK qfg-login boot check
└── verify-dev-injection/        # Token-file -> dev-override injection check
```

## Weighted-rollout fixtures

These fixtures pin the weight-scale contract:

- `feature-flag.weighted.even-split-ones` — the CANONICAL even-split
  encoding: all weights equal (1/1). Evaluation normalizes by total, so it
  serves 50/50. This is valid data the editor writes for "Split evenly".
- `feature-flag.weighted.non-standard` — DELIBERATELY NON-CONFORMING
  weights (100000/80000, sum 180000). It pins the SDK resilience contract:
  normalize by total, serving true 55.6% / false 44.4%. This fixture is
  hand-maintained — never round-trip it through qfg tooling; `qfg verify`
  and every write path reject this shape by design.
- `feature-flag.weighted.zero-first` — first variant at weight 0 (0/100000),
  hashing on `user.tracking_id`. Pins that a 0% variant is never served,
  including when the hash property is missing.
- `feature-flag.weighted.missing-hash` — weights 69000/1000/30000 with the
  1% variant placed where `configKey + ""` hashes (0.6947). Pins that a
  missing or empty hash property hashes the empty string.
- `feature-flag.weighted.no-hash` — 50/50 with no `hashByPropertyName`. Pins
  random-per-evaluation via `repeat` + `expected.values_seen`.

There is intentionally no zero-total (0/0) case: SDKs diverge at zero total
and the write layers make it unstorable.

## Duration grammar fixture

`tests/duration/grammar.yaml` is the single definition of the accepted
ISO-8601 duration grammar (fraction on S only, max 9 fractional digits,
no dangling T, magnitude <= P36500D). Writers, `qfg verify`, the corpus
scan and SDK tests load it instead of keeping their own copy.

```yaml
valid:                                   # must parse; millis is exact decimal, round half up
  - { value: "P1DT6H2M1.5S", millis: 108121500 }
invalid:                                 # must be rejected
  - "PT0.5H"
```

Self-check: `cd generators && npm test` (`src/shared/duration-grammar.test.ts`).

## Regex dialect fixture

`tests/regex/dialect.yaml` defines "Quonfig regex v1", the patterns
`PROP_MATCHES` and `PROP_DOES_NOT_MATCH` accept: the intersection of what
every SDK's engine reads the same way, plus a ReDoS safety rule (no
quantified group containing a quantifier or `|`, at most 2 unbounded
quantifiers, at most 256 characters). It is for the writers (cli
`qfg verify` and push, app-quonfig): each `reject` row carries a reason
code, and `hints` gives the fix-it text per code. SDKs do not validate;
their evaluation contract (unanchored search; invalid pattern, non-string
value or missing property make both operators false) is in
`tests/eval/enabled.yaml`.

```yaml
accept:
  - { pattern: '^[0-9]{3}$' }
reject:
  - { pattern: '(a+)+', reason: nested-quantifier }
```

Self-check: `cd generators && npm test` (`src/shared/regex-dialect.test.ts`).

## Workflow

```
1. Edit YAML test definitions in tests/eval/
          │
          ▼
2. Run /verify-sdks to see coverage gaps
          │
          ▼
3. For each SDK with gaps, run /generate-integration-suite-tests
          │
          ▼
4. Run each SDK's test suite to confirm tests pass
          │
          ▼
5. Run /verify-sdks again to confirm full coverage
```

## YAML Test Format

### Evaluation tests (`function: get`, `enabled`, `get_or_raise`, etc.)

```yaml
function: get
tests:
  - cases:
      - name: "test case description"   # Cross-SDK identifier
        client: config_client
        function: get
        type: STRING                     # STRING, INT, DOUBLE, BOOLEAN, STRING_LIST, JSON, DURATION
        input:
          key: "config-key"
          default: "fallback"            # Optional
        contexts:                        # Optional, three-level hierarchy
          global: { user: { email: "a@b.com" } }
          block:  { user: { key: "alice" } }
          local:  { user: { name: "Alice" } }
        expected:
          value: "expected-result"
          millis: 200                    # For DURATION type
          status: raise                  # For error cases
          error: missing_default         # Error type
        client_overrides:                # Optional SDK config
          on_no_default: 2
```

### Typed-getter contract (`getter.contract.*`)

`get.yaml`, `get_or_raise.yaml` and `enabled.yaml` each end with the cross-SDK typed-getter
matrix: every getter type read against every other stored type, strings that look
like other types, safe int <-> double conversions, malformed ints/doubles, a missing ENV_VAR and
a decryption failure, each as {with a default, with no default, `get_or_raise`, `enabled`}. The
rule is written out once, in the comment block above the matrix in `get.yaml`; the fixtures are
`data/integration-tests/configs/getter.contract.*.json`. A wrong-type `get_or_raise` expects
`error: type_mismatch`.

### Init-failure cases (`get_or_raise.yaml`, `function: init`)

The SDK's own init path against unreachable delivery legs. The keys and the expected errors are
documented once, in `generators/src/shared/init-failure.ts` (spec:
`project/plans/2026-10-05-init-failure-design.md`). Every target except go emits a self-contained
client builder; sdk-go supplies `newInitFailureClient` by hand (contract in `generators/src/targets/go.ts`).

```yaml
      - name: "init with on_init_failure fail raises when every delivery leg refuses the connection"
        function: init
        expected:
          status: raise
          error: init_failed             # or initialization_timeout
          reason: unavailable            # unavailable | unauthorized | timeout
          raises_within_ms: 5000         # Optional bound on the init call
        client_overrides:
          on_init_failure: fail          # fail | wait | continue; raise/return = deprecated aliases; absent = SDK default (fail)
          init_timeout_ms: 500
          api_urls: ["http://127.0.0.1:1", "http://127.0.0.1:2"]   # or api_status: 401
```

`init_timeout_ms` may be 0 (one attempt, then `on_init_failure`). `api_status` takes a number (two legs)
or a per-leg list (`[401, 503]` = primary 401, secondary 503); `api_body` sets the local legs' response
body. On a `function: init` case, `expected.message_excludes` must hold for the init error's message and
every message in its cause chain. Hung legs use `192.0.2.1:8001`/`:8002`, never port 1 (on the fetch
bad-ports list, so node fails it at once).

### Telemetry tests (`function: post`)

```yaml
function: post
tests:
  - cases:
      - name: "test case description"
        client: client
        function: post
        aggregator: evaluation_summary   # evaluation_summary, context_shape, example_contexts
        endpoint: "/api/v1/telemetry"
        contexts:                        # Optional context for evaluations
          block:
            user:
              tracking_id: "92a202f2"
        data:
          keys:                          # Keys to evaluate (evaluation_summary)
            - "my-config-key"
        expected_data:
          - key: "my-config-key"
            type: CONFIG                 # CONFIG, FEATURE_FLAG
            value: "the-value"
            value_type: string
            count: 1
            reason: 1                    # 0=UNKNOWN, 1=STATIC, 2=TARGETING_MATCH, 3=SPLIT, 4=DEFAULT, 5=ERROR
            selected_value:              # Optional: explicit JSON type wrapping
              string: "the-value"
            summary:
              config_row_index: 0
              conditional_value_index: 0
              weighted_value_index: 0    # Only for weighted/split evaluations
        client_overrides:
          collect_evaluation_summaries: false
          context_upload_mode: :shape_only  # :none, :shape_only, :periodic_example
```

## Adding New Test Types

1. Create a new YAML file in `tests/eval/` following the format above
2. If new config data is needed, add JSON files to `data/integration-tests/`
3. Run `/verify-sdks` — it will show all SDKs as missing coverage
4. Update each SDK's `generate-integration-suite-tests` skill if the new test type requires new helpers
5. Run the generation skill in each SDK
6. Run tests, iterate until passing

## SDKs

The six backend SDKs generate their tests from this corpus. The browser SDKs
(sdk-javascript, sdk-react) poll and are not corpus consumers.

| SDK | Generator target | Generated test dir |
|-----|------------------|--------------------|
| sdk-go | `generators/src/targets/go.ts` | `internal/fixtures/` |
| sdk-node | `generators/src/targets/node.ts` | `test/integration/` |
| sdk-python | `generators/src/targets/python.ts` | `tests/integration/` |
| sdk-ruby | `generators/src/targets/ruby.ts` | `test/integration/` |
| sdk-java | `generators/src/targets/java.ts` | `core/src/test/java/com/quonfig/sdk/integration/` |
| sdk-net | `generators/src/targets/dotnet.ts` | `tests/Quonfig.Sdk.Tests/Integration/` |

# integration-test-data

Shared test definitions and config data for all Quonfig SDKs. Every SDK generates idiomatic tests from these YAML definitions to guarantee behavioral consistency across languages.

## Directory Structure

```
integration-test-data/
├── tests/
│   └── eval/              # YAML test definitions
│       ├── get.yaml             # Config retrieval
│       ├── enabled.yaml         # Feature flag enabled checks
│       ├── get_feature_flag.yaml
│       ├── get_or_raise.yaml    # Error handling
│       ├── get_weighted_values.yaml
│       ├── context_precedence.yaml
│       ├── enabled_with_contexts.yaml
│       ├── post.yaml            # Telemetry: eval summaries, context shapes, examples
│       └── telemetry.yaml       # Telemetry: reasons, value wrapping, edge cases
├── data/
│   └── integration-tests/
│       ├── configs/         # Config JSON files
│       ├── feature-flags/   # Feature flag JSON files
│       ├── log-levels/      # Log level JSON files
│       ├── segments/        # Segment JSON files
│       └── schemas/         # Schema JSON files
├── environments.json        # Maps environment IDs to names
└── .claude/
    └── skills/
        └── verify-sdks.md   # Skill to check all SDKs have generated tests
```

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

| SDK | Language | Generated Test Dir | Skill |
|-----|----------|-------------------|-------|
| sdk-go | Go | `internal/fixtures/*_generated_test.go` | `.claude/skills/generate-integration-suite-tests.md` |
| sdk-node | TypeScript | `test/integration/*.generated.test.ts` | `.claude/skills/generate-integration-suite-tests.md` |
| sdk-javascript | TypeScript | TBD | Not yet created |

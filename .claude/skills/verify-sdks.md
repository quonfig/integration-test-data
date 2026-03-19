# verify-sdks

Verify that all SDKs have generated integration tests covering every YAML test definition.

## What this skill does

1. **Discover SDKs**: Find all `sdk-*` sibling directories relative to this repo (e.g., `../sdk-go`, `../sdk-node`, `../sdk-javascript`)

2. **Discover test definitions**: List all YAML files in `tests/eval/` — these are the source of truth for what every SDK must test

3. **For each SDK**, check:
   - Does the SDK have a `.claude/skills/generate-integration-suite-tests.md` skill? If not, flag it as "no generation skill"
   - Read the skill to find the generated test output directory
   - For each YAML file in `tests/eval/`, check if a corresponding generated test file exists in the SDK's output directory
   - Check if the generated test file is stale (YAML file modified more recently than generated file)

4. **Report results** as a clear table:

```
=== Integration Test Coverage Report ===

YAML definitions: 9 files
  - get.yaml, enabled.yaml, post.yaml, telemetry.yaml, ...

SDK: sdk-go (Go)
  Output dir: internal/fixtures/
  Skill: .claude/skills/generate-integration-suite-tests.md
  ✅ get.yaml → get_generated_test.go
  ✅ enabled.yaml → enabled_generated_test.go
  ❌ post.yaml → MISSING
  ❌ telemetry.yaml → MISSING
  Coverage: 7/9

SDK: sdk-node (TypeScript/Vitest)
  Output dir: test/integration/
  Skill: .claude/skills/generate-integration-suite-tests.md
  ✅ get.yaml → get.generated.test.ts
  ❌ post.yaml → MISSING
  ❌ telemetry.yaml → MISSING
  Coverage: 7/9

SDK: sdk-javascript
  ⚠️  No generation skill found
  Coverage: 0/9
```

## Step-by-step

1. List all YAML files in `tests/eval/`:
   ```
   ls tests/eval/*.yaml
   ```

2. Find all SDK directories:
   ```
   ls -d ../sdk-*
   ```

3. For each SDK:
   a. Check for `.claude/skills/generate-integration-suite-tests.md`
   b. Read the skill to find the output directory pattern and file naming convention
   c. For each YAML file, derive the expected generated filename:
      - **Go**: `<name>_generated_test.go` in `internal/fixtures/`
      - **Node**: `<name>.generated.test.ts` in `test/integration/`
      - Other SDKs: infer from the skill definition
   d. Check if the generated file exists
   e. Compare modification times (YAML vs generated file)

4. Output the report

## File naming conventions

| SDK | YAML file | Generated file |
|-----|-----------|---------------|
| sdk-go | `get.yaml` | `internal/fixtures/get_generated_test.go` |
| sdk-node | `get.yaml` | `test/integration/get.generated.test.ts` |

For YAML files with underscores (e.g., `get_or_raise.yaml`):
| SDK | YAML file | Generated file |
|-----|-----------|---------------|
| sdk-go | `get_or_raise.yaml` | `internal/fixtures/get_or_raise_generated_test.go` |
| sdk-node | `get_or_raise.yaml` | `test/integration/get_or_raise.generated.test.ts` |

## What to flag

- **MISSING**: YAML file exists but no generated test file
- **STALE**: Generated file is older than the YAML file (needs regeneration)
- **NO SKILL**: SDK has no generation skill (can't generate tests)
- **EXTRA**: Generated test file exists but no corresponding YAML (orphaned)

## Suggested next steps

After running this skill, if there are gaps:
1. `cd` into the SDK with missing coverage
2. Run the `/generate-integration-suite-tests` skill for the missing YAML files
3. Run the SDK's test suite to verify
4. Come back and run `/verify-sdks` again to confirm full coverage

---
name: q-sdks-verify
description: Verify that all SDKs have generated integration tests covering every YAML test definition. Use when checking cross-SDK test coverage.
paths: ["integration-test-data/**"]
---

# q-sdks-verify

Verify that every SDK has generated integration tests covering every YAML
test definition in `integration-test-data/tests/eval/`.

## Layout (post-unification)

- Skills live in `integration-test-data/.claude/skills/`
- The single TS generator lives in `integration-test-data/generators/`
  (one entry point, one target file per SDK under `src/targets/`)
- Generated test files land in each SDK's repo via the generator's per-target output dir

## What this skill does

1. **Discover SDKs**: Find sibling `sdk-*` repos relative to
   `integration-test-data/`. SDKs without an integration suite
   (`sdk-javascript`, `sdk-react`) are intentionally out of scope.

2. **Discover test definitions**: List every YAML in
   `integration-test-data/tests/eval/`. Those are the source of truth.

3. **For each in-scope SDK**, look up its expected output directory and
   filename pattern (see table below) and check:
   - Is a generated file present for each YAML?
   - Is the generated file older than its YAML (stale)?
   - Are there orphan generated files with no matching YAML?

4. **Report** as a clear table — present, missing, stale, orphan.

## File naming conventions

Wired up in `integration-test-data/generators/src/targets/<lang>.ts`. Match
the table here against the source of truth in those files.

| SDK       | Output dir                          | Pattern                          |
|-----------|-------------------------------------|----------------------------------|
| sdk-ruby  | `test/integration/`                 | `test_<suite>.rb`                |
| sdk-go    | `internal/fixtures/`                | `<suite>_generated_test.go`     |
| sdk-node  | `test/integration/`                 | `<suite>.generated.test.ts`     |
| sdk-python| `tests/integration/`                | `test_<suite>.py`               |

For YAML files with underscores (e.g. `get_or_raise.yaml`), keep them in
the suite slug as-is: e.g. `test_get_or_raise.rb`,
`get_or_raise_generated_test.go`, `get_or_raise.generated.test.ts`.

## What to flag

- **MISSING**: YAML exists, no generated file
- **STALE**: generated file mtime older than the YAML's
- **ORPHAN**: generated file with no matching YAML
- **NO TARGET**: SDK is in scope but `src/targets/<lang>.ts` doesn't exist yet

## Suggested next steps

If you find gaps:

1. From `integration-test-data/generators/`, run `npm run generate -- --target=<sdk>`
2. Run the SDK's test suite to confirm the new tests load and report honestly
3. Re-run this skill to confirm coverage

(Parity / shape checking against the YAML's `expected.value` is a
follow-up — this skill currently checks file presence + freshness only.)

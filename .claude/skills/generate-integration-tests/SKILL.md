---
name: generate-integration-tests
description: Regenerate per-SDK integration tests from the cross-SDK YAML in tests/eval/ via the unified TypeScript generator at integration-test-data/generators/. Use when YAML test definitions change, when generated tests need a refresh, or when adding a new SDK target.
paths: ["integration-test-data/**", "sdk-ruby/**", "sdk-go/**", "sdk-node/**", "sdk-python/**"]
---

# generate-integration-tests

One generator, one source of truth. The cross-SDK YAML in
`integration-test-data/tests/eval/*.yaml` is the contract. The TypeScript
generator at `integration-test-data/generators/` reads it and writes
language-native test files into the sibling SDK repos.

## When to use

- A YAML file under `tests/eval/` changed
- An SDK's generated tests look stale
- You added a new YAML test case
- You're porting a new SDK target into the generator (then read `src/targets/ruby.ts` as the reference)

## How to run

```bash
cd integration-test-data/generators
npm install            # first time only
npm run generate                  # all targets (TBD ones print a notice)
npm run generate -- --target=ruby # one target at a time
```

All four targets are implemented: `ruby`, `go`, `node`, `python`.
Running `npm run generate` with no `--target` flag generates all of them
in one pass.

## Output locations

| Target | Output dir | File pattern |
|--------|------------|--------------|
| ruby   | `../sdk-ruby/test/integration/`        | `test_<suite>.rb`              |
| go     | `../sdk-go/internal/fixtures/`         | `<suite>_generated_test.go`    |
| node   | `../sdk-node/test/integration/`        | `<suite>.generated.test.ts`    |
| python | `../sdk-python/tests/integration/`     | `test_<suite>.py`              |

(The generator writes to sibling git repos. Each affected repo needs its
own commit afterward.)

## After regenerating

### Step 1: format + lint the regenerated files

The generator emits source-faithful but not always lint-clean output —
import ordering, unused imports, `== None` vs `is None`, trailing
whitespace, etc. Run each target's formatter/linter on the regenerated
directory before committing, otherwise CI fails and you'll spend a follow-up
commit reverting lint regressions that the generator just re-introduced.

| Target | Run from | Command |
|--------|----------|---------|
| ruby   | `sdk-ruby`   | `bundle exec rubocop --autocorrect-all test/integration/` (if rubocop is in the gemfile) |
| go     | `sdk-go`     | `gofmt -w internal/fixtures/ && go vet ./internal/fixtures/...` |
| node   | `sdk-node`   | `pnpm prettier --write test/integration/ && pnpm eslint --fix test/integration/` |
| python | `sdk-python` | `poetry run ruff check --fix tests/integration/ && poetry run ruff format tests/integration/` |

Expected real lint findings (fixable with the autocorrect flag above):
- python: unused `import os` / `import pytest`, alphabetical import order,
  `== None` → `is None`
- node: unused imports, formatting drift
- ruby: alignment, trailing whitespace

If the generator keeps reintroducing the same lint issue every regen,
fix it in the generator template (`integration-test-data/generators/src/targets/<lang>.ts`)
rather than autocorrecting in the SDK every time.

### Step 2: run the target SDK's test suite

See what's now red. **Some failures are expected** when YAML changes outpace
SDK behavior. That is the point — the generator deliberately does not hide
gaps with skips.

```bash
# ruby
git -C ../sdk-ruby status
cd ../../sdk-ruby && bundle exec rake test
```

## The hard rule: no auto-skips

The generator NEVER emits `t.Skip`, `it.skip`, `pytest.skip`,
`skip(...)`, or wrap-and-rescue patterns that swallow failures. Every YAML
case becomes a real, runnable assertion.

If a YAML case can't be expressed in a target SDK:

1. **First choice**: extend the SDK (or its integration helpers) so the
   case becomes expressible.
2. **Otherwise**: remove the case from YAML — that's a contract decision,
   not a generator decision.

The generator will surface these by either failing loudly (unmapped
`expected.error`, missing `input.key`) or by omitting the case from its
output file with a comment listing what was omitted (post/telemetry-style
shapes that don't match current SDK helpers). Both pathways are visible —
neither pretends the case passed.

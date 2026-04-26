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

Targets currently supported: `ruby`. `go`, `node`, `python` print
"not yet implemented" until follow-up agents land them.

## Output locations

| Target | Output dir | File pattern |
|--------|------------|--------------|
| ruby   | `../sdk-ruby/test/integration/`        | `test_<suite>.rb`              |
| go     | `../sdk-go/internal/fixtures/`         | `<suite>_generated_test.go`   (TBD) |
| node   | `../sdk-node/test/integration/`        | `<suite>.generated.test.ts`   (TBD) |
| python | `../sdk-python/tests/integration/`     | `test_<suite>.py`             (TBD) |

(The generator writes to sibling git repos. Each affected repo needs its
own commit afterward.)

## After regenerating

Run the target SDK's test suite to see what's now red. **Some failures are
expected** when YAML changes outpace SDK behavior. That is the point — the
generator deliberately does not hide gaps with skips.

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

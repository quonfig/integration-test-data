---
name: q-sdks-verify
description: Verify that all SDKs have generated integration tests covering every YAML test definition. Use when checking cross-SDK test coverage.
paths: ["integration-test-data/**"]
---

# q-sdks-verify

Real cross-SDK parity gate, plus a GitHub Actions status check.

## When to use

- After regenerating per-SDK tests (`npm run generate`)
- Before merging YAML changes in `integration-test-data/tests/eval/`
- Periodic audits — confirms every YAML case has a runnable test in every SDK
  with zero skips and that each SDK's CI on `main` is green

## How to run

```bash
cd integration-test-data/generators
npm run verify
```

Exits non-zero on any failure. Prints a per-SDK breakdown plus a GitHub
Actions table. Backed by `src/verify.ts`.

## What it checks

1. **Case-name parity** — every YAML case in `tests/eval/*.yaml` exists
   verbatim in every SDK's generated file (Ruby, Go, Node, Python). Case
   names are extracted from the leading `# <name>` / `// <name>` comment
   the generators emit (Node uses the `it("...", ...)` string).
2. **Zero-skip rule** — greps each generated file for skip patterns
   (`skip(`, `pending`, `t.Skip*`, `it.skip`, `describe.skip`, `it.todo`,
   `pytest.skip(`, `@pytest.mark.skip`, `@unittest.skip`). Any match fails.
3. **Zero-omission rule** — generated files must contain at least one test;
   an empty test class fails this check.
4. **GitHub Actions status** — for each SDK and `integration-test-data`,
   uses `gh` to fetch the latest run on `main` for every active workflow.
   Pass requires `status=completed`, `conclusion=success`. Failures,
   in-progress runs, or missing runs all count as fail.

## What to do when it fails

| Failure | Fix |
|---|---|
| MISSING `<name>` in `<sdk>` | Regenerate that SDK: `npm run generate -- --target=<sdk>` |
| EXTRA `<name>` in `<sdk>` | Stale generated file — regenerate or delete the orphan |
| Skip / pending / todo hit | Remove the skip and ship a real assertion |
| Empty test file | Generator bug — fix the target template, regenerate |
| GH Action failure | Click the URL, fix the SDK build, push |
| `gh` not authenticated | `gh auth login`, then re-run |

## Layout

- Skill lives at `integration-test-data/.claude/skills/q-sdks-verify/SKILL.md`
- Verifier lives at `integration-test-data/generators/src/verify.ts`
- Output dir conventions live in `integration-test-data/generators/src/targets/<lang>.ts`

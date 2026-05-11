---
name: q-sdk-boot-check
description: Assert that every backend SDK (sdk-python, sdk-node, sdk-ruby, sdk-go) can construct a client and serve a config evaluation WITHOUT `QUONFIG_BACKEND_SDK_KEY`, relying only on `~/.quonfig/tokens.json` from `qfg login`. Run this after touching any SDK's dev-context loader, options parsing, or constructor's SDK-key handling — and as part of a standard SDK verification pass.
paths: ["integration-test-data/**", "sdk-node/**", "sdk-go/**", "sdk-ruby/**", "sdk-python/**"]
---

# q-sdk-boot-check

Catches regressions in the `qfg login` flow: a customer expects to run their
backend app locally with just `qfg login` + `QUONFIG_ENVIRONMENT` and no SDK
key. If a SDK silently regresses on dev-context discovery or starts demanding
`QUONFIG_BACKEND_SDK_KEY` again, this skill notices in 30 seconds instead of a
customer report week later (see qfg-jopa / qfg-is5o for context).

## When to use

- After editing any SDK's `dev_context` / `devContext` module.
- After changing how a SDK handles a missing `sdk_key` (constructor branch,
  options parsing, error messages).
- Before merging a SDK release.
- Quick periodic spot-check of all four backend SDKs at once.

## How to run

```bash
integration-test-data/verify-sdk-boot/run.sh
```

Exits non-zero if any SDK fails. Prints one `OK` / `FAIL` line per SDK plus a
summary.

## What it checks per SDK

1. `QUONFIG_BACKEND_SDK_KEY` is unset (boot-check refuses to run otherwise).
2. A synthetic `~/.quonfig/tokens.json` fixture (created by `run.sh` in a
   tmpdir) is the only auth/identity input.
3. The SDK constructor succeeds — no "SDK key required" throw.
4. `get('brand.new.string')` returns `"hello.world"` from the local datadir
   (`integration-test-data/data/integration-tests/`).
5. (Python, Node, Ruby) `quonfig-user.email` is present in the merged context
   or what the loader returns. Go skips this since its loader + options are
   both unexported; `sdk-go/dev_context_test.go` covers that path inside the
   package.

## Why a datadir, not a pure-tokens.json boot

sdk-node and sdk-ruby refuse to construct in network mode without an SDK key
— that's the documented behavior. The realistic local-dev analogue of
"`qfg login` and run my app" is "I have a local workspace (datadir) and I'm
logged in for context enrichment." The boot-check mirrors that flow.

## What to do when it fails

| Failure | Likely cause |
|---|---|
| `dev_context loader returned None` | The SDK's tokens.json discovery regressed — check `HOME` resolution, filename derivation, or JSON parsing. |
| `client.globalContext.quonfig-user.email = undefined` | The constructor's dev-context wiring isn't merging the loader's return into the global context. |
| `Quonfig() raised without sdk_key` | The SDK regressed to requiring `QUONFIG_BACKEND_SDK_KEY` even in datadir mode. |
| `get_string returned ...` | The datadir workspace wasn't loaded, or the config evaluator regressed. |

## Layout

- Skill: `integration-test-data/.claude/skills/q-sdk-boot-check/SKILL.md`
- Runner: `integration-test-data/verify-sdk-boot/run.sh`
- Per-SDK scripts: `integration-test-data/verify-sdk-boot/boot_check.{py,mjs,rb}` and `boot_check_go/main.go`
- Datadir fixture: `integration-test-data/data/integration-tests/` (the shared cross-SDK workspace)

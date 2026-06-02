# verify-dev-injection

Front-half coverage for the dev-context feature: proves each backend SDK
**auto-injects** `quonfig-user.email` from `~/.quonfig/tokens.json` into the
evaluation context **by default**, with no opt-in.

This is the gap the `dev_overrides.yaml` corpus does not cover. Those cases
hand `quonfig-user.email` to the evaluator directly, so they pass even for an
SDK that has no token-file loader at all (this is exactly why Java/.NET shipped
green dev-override tests despite missing the loader). This harness instead
boots a **default-config** client — no `enableQuonfigUserContext`, no
`QUONFIG_DEV_CONTEXT` — and checks the token-file → injection → eval round trip.

Run it:

```bash
./run.sh            # all in-scope SDKs
./run.sh sdk-node   # just one (used by the per-SDK beads)
```

Exits non-zero on any SDK failure.

## The contract

Each SDK is exercised in two phases against the shared bool flag
`feature-flag.dev-override` (fixture:
`data/integration-tests/feature-flags/feature-flag.dev-override.json`, whose
rule matches `quonfig-user.email == bob@foo.com`):

| Phase         | tokens.json            | Expected `get_bool` |
|---------------|------------------------|---------------------|
| token-present | `userEmail: bob@foo.com` | `true`              |
| no-token      | (absent)               | `false`             |

In the token-present phase, a default-config client must inject
`quonfig-user.email=bob@foo.com` on its own for the rule to fire. An SDK whose
dev-context default is still **opt-in** returns `false` here → the check FAILS.
That is the intended RED: flipping the SDK default to on turns it GREEN. The
no-token phase passes regardless (nothing to inject → fallback rule → false).

## Layout

```
verify-dev-injection/
├── run.sh                 # orchestrator: two-phase fixture, invokes each SDK
├── inject_check.py        # sdk-python (runs via `poetry run python`)
├── inject_check.mjs       # sdk-node   (imports from sdk-node/dist)
├── inject_check.rb        # sdk-ruby   (requires from sdk-ruby/lib)
└── inject_check_go/       # sdk-go     (own module with `replace` -> ../../../sdk-go)
```

Scope mirrors `verify-sdk-boot`: sdk-node, sdk-go, sdk-ruby, sdk-python.
sdk-java / sdk-net join once their token-file loaders land (qfg-bw7g.6/.7).
Browser SDKs are excluded — no filesystem.

## Prerequisites

- Python: `cd sdk-python && poetry install` (once).
- Node: `cd sdk-node && pnpm build` (the check imports from `dist/`).
- Ruby: `cd sdk-ruby && bundle install` (once).
- Go: nothing — `go run .` builds on demand.

# verify-sdk-boot

Per-SDK boot-check that catches regressions in the `qfg login` flow.

Each backend SDK (sdk-python, sdk-node, sdk-ruby, sdk-go) must be able to
construct a client and evaluate a flag with NO `QUONFIG_BACKEND_SDK_KEY`,
relying only on `~/.quonfig/tokens.json` for the dev's email. This script
points each SDK at a synthetic fixture and asserts the round trip works.

Run it:

```bash
./run.sh
```

Exits non-zero on any SDK failure. See
`integration-test-data/.claude/skills/q-sdk-boot-check/SKILL.md` for the
full skill doc and failure → diagnosis table.

## Layout

```
verify-sdk-boot/
├── run.sh                 # orchestrator: creates fixture, invokes each SDK
├── boot_check.py          # sdk-python (runs via `poetry run python`)
├── boot_check.mjs         # sdk-node   (runs via plain `node`, imports from sdk-node/dist)
├── boot_check.rb          # sdk-ruby   (runs via plain `ruby`, requires from sdk-ruby/lib)
└── boot_check_go/         # sdk-go     (own module with `replace` -> ../../../sdk-go)
    ├── go.mod
    ├── go.sum
    └── main.go
```

The Go module is isolated from the monorepo `go.work` (we set `GOWORK=off`
before running) so the local `replace` directive resolves without having to
list this directory in the workspace.

## Prerequisites

- Python: `cd sdk-python && poetry install` (once).
- Node: `cd sdk-node && pnpm build` (the boot-check imports from `dist/`).
- Ruby: `cd sdk-ruby && bundle install` (once).
- Go: nothing — `go run .` builds on demand.

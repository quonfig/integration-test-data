# Chaos test harness

Cross-SDK network-chaos test harness. Every backend SDK (`sdk-go`, `sdk-node`, `sdk-python`, `sdk-ruby`, `sdk-java`) runs the same scenarios from the same YAML against the same launcher — so a regression in any one SDK shows up the same way it would in production.

Lives next to `tests/eval/` because chaos blocks are an additive YAML shape on top of the existing integration-test-data contract.

Plan: `project/plans/sdk-hardening-and-verification.md` (sections "Test strategy / Tier 0+2+3" and "Phase 0 — Test harness first"). Bead: `qfg-47c2.1`.

## Layout

```
chaos/
  README.md                  this file
  docker-compose.yml         shared launcher (toxiproxy + optional api-delivery)
  start-chaos.sh             boot wrapper; seeds named proxies via the toxiproxy API
  stop-chaos.sh              teardown
  toxiproxy/proxies.json     empty seed (start-chaos.sh creates the proxies at boot)
  schema/scenario.schema.json  JSON-schema for chaos YAML
  scenarios/                 default suite — every SDK runner globs *.yaml here
  scenarios-http-proxy/      requires HTTP-aware injection (not toxiproxy)
  scenarios-manual/          deferred / out-of-band; not wired to any SDK runner
  validator/                 node validator + tests; CI gate for the schema
```

## Scenario directories — what each is for

Every SDK runner does `glob("scenarios/*.yaml")` at the top level. Moving a YAML into a sibling subdir auto-excludes it from the default chaos run; runners that want the alternate harness pick them up explicitly.

- **`scenarios/`** — the default suite. Every YAML here is expected to be feasible against toxiproxy (TCP-level chaos: stalls, latency, bandwidth, disables, byte limits, process flapping). A failure here is either a real SDK bug or a runner bug — never a known infrastructure limitation. **The default chaos run is intended as a green/red signal you can trust.**
- **`scenarios-http-proxy/`** — scenarios that require HTTP-aware injection (auth failures, bad response bodies, malformed headers). Toxiproxy is TCP-only and structurally cannot model these. A future HTTP-aware harness (mitmproxy, mock server, or per-SDK fixture mode) will pick these up — for now they sit here as a record of intent. SDK runners do NOT include this directory by default.
- **`scenarios-manual/`** — scenarios that don't fit either automated harness today (process-level chaos requiring container privileges, multi-host scenarios, etc.). Placeholder; populate as the need arises.

## Boot the harness

```bash
cd integration-test-data/chaos

# Toxiproxy only — SDK CI brings its own api-delivery upstream.
./start-chaos.sh

# Toxiproxy + api-delivery in fixture mode (standalone).
./start-chaos.sh --with-upstream

# Point at a custom upstream that already exists on the host.
./start-chaos.sh --upstream-host my-host --upstream-port 6550

./stop-chaos.sh
```

Boot is ~3 seconds (acceptance target was <5 min).

After boot:

| Endpoint                         | URL                            | Notes                          |
| -------------------------------- | ------------------------------ | ------------------------------ |
| Toxiproxy admin API              | `http://127.0.0.1:8474`        | inject/clear toxics here       |
| Chaos SSE port                   | `http://127.0.0.1:18550`       | SDK clients target this        |
| Chaos HTTP port                  | `http://127.0.0.1:18551`       | SDK clients target this        |
| api-delivery (with `--with-upstream`) | `http://127.0.0.1:6550`   | only when profile is on        |

All port and host knobs can be overridden via env (`SSE_PROXY_PORT`, `HTTP_PROXY_PORT`, `TOXIPROXY_ADMIN_PORT`, `CHAOS_UPSTREAM_HOST`, `CHAOS_UPSTREAM_SSE`, `CHAOS_UPSTREAM_HTTP`).

## Scenarios

The plan's Tier 2 table, one YAML per scenario. Most live in `scenarios/` (the default suite); scenarios that need HTTP-aware injection live in `scenarios-http-proxy/`.

### Default suite (`scenarios/`)

| File                            | What it stresses                                   |
| ------------------------------- | -------------------------------------------------- |
| `01-baseline.yaml`              | Healthy server + network. Null baseline.           |
| `02-silent-stall.yaml`          | Silent SSE socket stall — Layer 1 must trip.       |
| `03-latency.yaml`               | 5s SSE latency — no fallback, no false trip.       |
| `04-bandwidth.yaml`             | 1 KB/s SSE — survive or trip cleanly.              |
| `05-sse-down.yaml`              | SSE down 180s — Layer 2 fallback engages.          |
| `06-total-partition.yaml`       | SSE + HTTP down — both layers fail clean, recover. |
| `07-half-open.yaml`             | 200 then close after 1 byte — no deadlock.         |
| `09-flapping.yaml`              | Toxiproxy killed 5x in 30s — eventual stability.   |
| `10-callback-throw.yaml`        | User callback throws — supervisor catches.         |
| `11-null-hypothesis.yaml`       | 30 min of nothing — no spurious reconnects.        |

### Requires HTTP-aware harness (`scenarios-http-proxy/`)

| File                            | Why it's not in the default suite                  |
| ------------------------------- | -------------------------------------------------- |
| `08-auth-failure.yaml`          | 401 response injection — toxiproxy is TCP-only and cannot rewrite HTTP responses. Needs mitmproxy / mock server / fixture mode. |

Each scenario is wall-clock-bounded (`setup.wall_clock_seconds`, ~30s default; longer for fallback engagement and the null-hypothesis run).

## YAML schema

Schema at `schema/scenario.schema.json`. Validated in CI via the node validator at `validator/`. Run locally:

```bash
cd integration-test-data/chaos/validator
mise exec -- npm install
mise exec -- npm test                  # schema + scenarios + bad-fixture tests
mise exec -- npm run validate          # CLI: every scenario must parse + validate
```

### Time-bounded assertions

The schema rejects any expectation that does not declare `within_ms`. This is non-negotiable per the plan: a final-state-only assertion lets the SDK cheat by sleeping until quiescent. Assertions must check **during** chaos, not just at the end.

```yaml
expectations:
  - within_ms: 90000
    assert: "client.connectionState() == 'reconnecting' OR client.connectionState() == 'falling_back'"
  - within_ms: 180000
    must_hold_for_ms: 30000   # optional: must keep holding for N ms after first true
    assert: "client.connectionState() == 'connected' AND server_metric('quonfig_subscriber_lag_seconds') == 0"
```

### Chaos blocks

Use the convenience aliases first; drop down to a raw toxiproxy `toxic` block only when nothing fits.

```yaml
chaos:
  - at_ms: 5000                              # relative to test start; default 0
    inject:
      name: stall                            # optional, for later `clear`
      sse_silent_stall_after_ms: 0
  - at_ms: 125000
    clear: stall

  # ...or low-level:
  - inject:
      proxy: sse
      toxic:
        type: bandwidth
        attributes: { rate: 1 }              # KB/s

  # ...or out-of-band:
  - process:
      action: kill_sse_proxy
      count: 5
      interval_ms: 6000
```

The assertion expressions (`client.connectionState()`, `server_metric(...)`, etc.) are interpreted by each per-SDK test runner — the schema only enforces presence and shape. The expression vocabulary is part of the per-SDK supervisor unit-test contract: see [`supervisor-test-contract.md`](./supervisor-test-contract.md) (plan reference: `project/plans/sdk-hardening-and-verification.md`, Tier 1).

## SDK CI wiring (one-time per SDK)

1. CI checks out `integration-test-data` as a sibling dir (existing pattern — see `project/plans/sdk-testing.md`).
2. CI starts the harness: `./integration-test-data/chaos/start-chaos.sh` (or `--with-upstream` if no api-delivery is otherwise available).
3. CI runs the SDK's chaos-test entrypoint, pointing the SDK at `127.0.0.1:18550` (SSE) and `127.0.0.1:18551` (HTTP).
4. Each scenario file is loaded via YAML, the `chaos` block is replayed against `http://127.0.0.1:8474`, the `expectations` are evaluated with the time bounds.
5. CI tears down: `./integration-test-data/chaos/stop-chaos.sh`.

The first SDK to be wired in is `sdk-go` (Phase 1 of the plan). Expect scenarios 2, 7, 9 to be red on `sdk-go` until the Layer 1 fix lands; that red is the point of the harness.

## Known gaps (intentionally not in scope)

- **HTTP/2 stream stall + TLS half-open.** Toxiproxy is TCP-only. Documented in the plan; deferred to Phase 5 synthetic monitor.
- **Per-SDK runner implementations.** The runners live in each SDK repo (per-language idiom). This directory only owns the schema, scenarios, and shared launcher.

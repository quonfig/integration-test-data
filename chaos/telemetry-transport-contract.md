# Telemetry transport contract

A shared spec with no shared code. Every Quonfig backend SDK (`sdk-node`,
`sdk-go`, `sdk-python`, `sdk-ruby`, `sdk-java`, `sdk-net`) implements tests
T1-T8 below in its own native test framework and language idiom, against its
own in-process HTTP stub, a mocked clock and a capturing logger. The frontend
and mobile SDKs (`sdk-javascript` + `sdk-react`, `sdk-swift`) implement the
subset listed under "Frontend and mobile".

Source plan: `project/plans/2026-09-24-sdk-telemetry-transport-policy.md` (in the monorepo `project/` repo)
(APPROVED 2026-09-25), section "Enforcement (transport contract: shared spec,
native tests)". The plan is the source of truth; if this doc and the plan
disagree, the plan wins and this doc gets fixed.

Epic: `qfg-y8je`. This doc: `qfg-y8je.3`. Modeled on
[`supervisor-test-contract.md`](./supervisor-test-contract.md).

## Why a native contract, not the corpus or the chaos rig

The corpus generator asserts values on deterministic in-process input, and its
only `http_wire` mock server (`delivery_environment.yaml`) is static-200 with
no scripting, delay or log capture in any of the six generator targets. The
chaos rig is toxiproxy, TCP-only, so it cannot inject 503/401/429
(`scenarios-http-proxy/08` is parked for that reason), runs on wall clock, has
no telemetry proxy or upstream, and the runners disable telemetry. Timeouts,
retry gaps, log-once and caps need a scripted endpoint and a controlled clock;
the supervisor contract already forced a clock seam into every backend SDK.
This contract reuses that pattern.

So: no `tests/telemetry/transport.yaml`, no generator, no corpus YAML, no
chaos scenario. Parity is by review, as with the supervisor contract; there
is no `verify.ts` gate.

## The policy under test (P1-P10)

Summarized from the plan. Tests reference these item numbers.

| #   | Policy               | Exact rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Timeouts             | Connect/TLS **5s** everywhere. Overall request: **15s** server SDKs (node, go, ruby, python, net, java), **10s** browser (js/react), **15s** mobile foreground (swift).                                                                                                                                                                                                                                                                                                                                             |
| P2  | One POST in flight   | At most one telemetry POST in flight per SDK instance. A tick that fires while a POST is out is skipped; the live window keeps aggregating.                                                                                                                                                                                                                                                                                                                                                                         |
| P3  | Retryable classes    | Retryable = network error, timeout, 408, 429, 5xx. Never other 4xx. On **401/403/404**: one ERROR line, drop the retained queue, disable telemetry for the process. On **any other 4xx** (400, 413, 422, ...): drop that batch, one ERROR, never retain, keep ticking.                                                                                                                                                                                                                                              |
| P4  | Resend schedule      | No immediate retry, no attempt counter, no exponential backoff. Carry the failed batch forward. On a tick that is allowed to send, drain retained batches **oldest-first**, then the live window, sequentially with one POST in flight at a time; stop the tick at the first failure. A tick is allowed to send when at least **30s** have passed since the last failure AND any `Retry-After` (honored up to **600s**, larger values clamped to 600s) has elapsed. Eviction is by queue cap and max age only (P5). |
| P5  | Byte-exact retention | Store the serialized bytes of a failed batch; never merge; never re-serialize. Queue cap: **5 batches or 2MB** for server SDKs, **512KB** for browser and mobile; drop **oldest**. A single batch larger than the byte cap is dropped, not retained, and counts as a drop for P7. A queued batch older than **5 min** is discarded. The server-SDK cap is 2MB per the 2026-09-25 prod measurement (see "Server-SDK byte cap" below).                                                                                |
| P6  | Memory caps          | Every aggregator bounded (summaries, context shapes, example contexts); uniform cap per SDK class; **drop newest** when full (existing keys keep incrementing); caps documented as options. Nothing grows with traffic.                                                                                                                                                                                                                                                                                             |
| P7  | Logging              | Only on data loss and on state change. Failed POST (timeout, 5xx, network) -> **DEBUG**. First batch DROPPED (cap, age, oversize or non-retryable) -> one **WARN** with status, queue depth, dropped count. Further drops -> DEBUG, with at most one WARN summary per **10 min** while dropping continues. Recovery (first 200 after a failure) -> one **INFO**. Auth failure -> one **ERROR** then silence. A timeout whose batch is later resent successfully never logs above DEBUG.                             |
| P8  | Shutdown             | `close()` does one final flush of the live window with a **5s** deadline (browser: keepalive/beacon on pagehide, **2s**; iOS: background task, ~**5s**). Does not drain the retry queue. Exit is never blocked.                                                                                                                                                                                                                                                                                                     |
| P9  | No client dedup key  | No client-side dedup key. The payload hash already acts as a payload ID for verbatim resends. Client UUIDs would dedup against the same ClickHouse window and fix nothing.                                                                                                                                                                                                                                                                                                                                          |
| P10 | Wire + API unchanged | Wire format and public API unchanged. Only new defaults and new options; semver **minor** per SDK.                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Defaults table

| Setting                              | Server SDKs (node, go, python, ruby, java, net) | Browser (js/react)             | Mobile (swift)             |
| ------------------------------------ | ----------------------------------------------- | ------------------------------ | -------------------------- |
| Connect/TLS timeout                  | 5s                                              | 5s                             | 5s                         |
| Overall request timeout              | 15s                                             | 10s                            | 15s (foreground)           |
| Flush interval (tick)                | 60s                                             | 30s                            | 60s                        |
| Resend floor after a failure         | 30s                                             | 30s                            | 30s                        |
| `Retry-After` honored up to          | 600s                                            | 600s                           | 600s                       |
| Retained queue cap                   | 5 batches / 2MB                                 | 5 batches / 512KB              | 5 batches / 512KB, on disk |
| Retained batch max age               | 5 min                                           | 5 min                          | 5 min                      |
| WARN summary interval while dropping | 10 min                                          | 10 min                         | 10 min                     |
| Shutdown final flush deadline        | 5s                                              | 2s (pagehide keepalive/beacon) | ~5s (background task)      |
| `contextUploadMode` default          | `periodic_example`                              | `periodic_example`             | `periodic_example`         |

The flush interval and `contextUploadMode` rows come from the plan's decided
"uniform defaults" (node drops from 8s to 60s; the adaptive up-to-600s
intervals in node and java are removed in favor of P4).

### Server-SDK byte cap: 2MB (decided 2026-09-25)

The sdk-node bead measured prod batch sizes (ClickHouse Cloud `telemetry_raw`,
trailing 24h, 121,414 server-SDK POSTs): p99 471KB (92% of 512KB), p99.5
914KB, p99.9 1.69MB, max 5.2MB; 1.07% of POSTs over 512KB, 0.07% over 2MB, all
sdk-ruby `example_context` events. A 512KB cap would turn ordinary batches from
the largest customers into oversize drops on a single 503, so the server-SDK
default is **2,097,152 bytes (2MB)**. Browser and mobile keep 512KB (browser
p99 is 8.6KB). Full numbers:
`project/plans/2026-09-25-sdk-node-transport-implementation.md` section 1 (in
the monorepo `project/` repo).

### The tick model the tests assume

P2 and P4 together define what one tick does. Every test below assumes this
sequence, so every SDK implements it the same way:

1. **Skip if busy.** If a POST is in flight, the tick does nothing. The live
   window keeps aggregating (P2).
2. **Expire.** Discard retained batches older than 5 min, measured from when
   the batch was serialized. Each discard is a drop (P7).
3. **Skip if not allowed.** If fewer than 30s have passed since the last
   failure, or a `Retry-After` has not elapsed, the tick sends nothing and the
   live window keeps aggregating.
4. **Close the window.** If the live window is non-empty, serialize it once
   into a batch and append it to the tail of the queue. An empty window
   produces no batch and no POST. Enforce the queue caps on append: evict
   oldest until the queue holds at most 5 batches and at most the byte cap.
   Each eviction is a drop (P7).
5. **Drain.** POST queued batches oldest-first, one at a time. On 2xx, remove
   the batch and continue. On a retryable failure, keep the batch (or drop it
   if it is larger than the byte cap), record the failure time and any
   `Retry-After`, and end the tick. On 401/403/404, drop the whole queue and
   disable telemetry. On other 4xx, drop that batch and continue.

## How to set up the test fixture

Every SDK exposes, behind a test-only seam, the pieces below. The fixture
must NOT mock the telemetry reporter or its queue; that defeats the test.
Mock only the HTTP endpoint, the clock and the logger.

- **A scriptable in-process HTTP stub.** A real HTTP server bound to
  `127.0.0.1` on an ephemeral port, with the SDK's telemetry URL pointed at
  it. The test scripts the response per received POST: status code, optional
  `Retry-After` header, optional delay, or hang (accept the request and never
  answer until the test releases it). The stub records the raw request body of
  every POST it receives, including aborted ones that reached it.
- **A mocked or compressed clock.** Tests must not sleep 15s for real. Use the
  same clock seam the supervisor contract introduced. The request timeout must
  fire off that clock. Where the HTTP client's timeout cannot be driven by a
  mocked clock, the SDK may run the test with a compressed timeout, but must
  then also assert that the default is 15000ms (10000ms browser).
- **A capturing logger at DEBUG.** The SDK logs through its normal logger
  interface, and the test captures every line with its level, so that episode
  counts can be asserted per level.
- **An injectable flush interval, or a directly callable tick.** Tests either
  set the interval and advance the clock, or call the tick themselves. T7
  needs to fire ticks while a POST is outstanding.
- **Test-visible queue state.** Read-only access to the retained-queue depth
  and total serialized bytes, and to whether telemetry is disabled.
- **Cap overrides.** The retained-queue byte cap and the aggregator caps are
  options (P6, P10). Tests may lower them to keep fixtures small, but must
  also assert the shipped defaults.

### Existing seams to reuse

| SDK        | What exists                                                                                      | What to add                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| sdk-go     | `httptest` `telemetryCapture` in `quonfig_failover_telemetry_test.go`                            | Scripting (status / Retry-After / hang), clock seam on the reporter, a logger (the telemetry package has none today) |
| sdk-node   | `node:http` stubs in `test/failover-telemetry.test.ts` and `test/close-drains-telemetry.test.ts` | Scripting; vitest fake timers                                                                                        |
| sdk-net    | WireMock.Net in `Telemetry/HttpTelemetrySenderTests.cs` (already scripts 200/401/503)            | Hang + Retry-After scripting, clock seam, capturing logger                                                           |
| sdk-ruby   | Reporter tests stub a fake connection object, not HTTP                                           | A real HTTP stub: WebMock or a local WEBrick                                                                         |
| sdk-python | Only JSON snapshot tests of the payload                                                          | A real HTTP stub, clock seam, capturing logger                                                                       |
| sdk-java   | Not audited                                                                                      | Check `TelemetryReporterTest` first and extend it                                                                    |

## Common assertion vocabulary

Tests reference these capabilities. Each SDK names them in its own idiom
(`PostCount()` in Go, `post_count` in Python and Ruby, `postCount()` in
Java and Node, `PostCount` in C#), but the meaning is fixed.

| Capability                         | Meaning                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `post_count`                       | POSTs the stub has received, including aborted ones that reached it.                                                    |
| `body(i)`                          | Raw bytes of the i-th received POST, 0-indexed. Tests compare `sha256(body(i))`, never a re-parsed form.                |
| `retained_count`, `retained_bytes` | Retained-queue depth and total serialized size in bytes. Excludes the live, not-yet-serialized window.                  |
| `log_count(level, /re/)`           | Matching log lines at that level since test start. Levels are DEBUG, INFO, WARN, ERROR (map WARNING / Warning to WARN). |
| `telemetry_enabled()`              | False once the SDK disabled telemetry for the process (P3).                                                             |
| `advance(ms)`                      | Move the mocked clock forward by `ms`; fires any ticks and timeouts that fall due.                                      |

Units: `KB` means 1024 bytes, so 512KB is 524,288 bytes.

Every test records evaluations through the SDK's normal public API (for
example `get(...)` on a flag with distinct context keys), so the batches the
SDK builds are real payloads. Unless a test says otherwise it uses the server
defaults: 60s flush interval, 15s timeout, 5 batches / 2MB (server; 512KB browser/mobile), 5 min max age.
"Tick k" means the k-th tick after the client starts, at `k * interval`.

## T1 - Timeout aborts and retains (P1, P5, P7)

**Goal:** A POST that never answers is aborted at 15s, its bytes are kept and
resent verbatim, and the whole episode stays at DEBUG except one recovery INFO.

**Setup:** Record some evaluations. Script the stub: POST 0 hangs, POST 1
answers 200.

**Steps and assertions:**

1. `advance(60000)` (tick 1). The SDK serializes the window and sends POST 0,
   which hangs.
2. `advance(15000)`. The request is aborted.
   - `post_count == 1`
   - `retained_count == 1`
   - `log_count(WARN, /.*/) == 0` and `log_count(ERROR, /.*/) == 0`
   - `log_count(DEBUG, /.*/) >= 1` (the failed POST)
3. `advance(45000)` (tick 2, 45s after the failure, so past the 30s floor).
   Record no new evaluations before this tick.
   - `post_count == 2`
   - `sha256(body(1)) == sha256(body(0))`
   - `retained_count == 0`
   - `log_count(INFO, /recover/i) == 1`
   - `log_count(WARN, /.*/) == 0` (a timeout whose batch is later resent
     successfully never logs above DEBUG)

**Also assert:** the default overall request timeout is 15000ms and the
connect timeout is 5000ms, read from the SDK's resolved options.

## T2 - 5xx retains verbatim and resends (P4, P5)

**Goal:** A retried batch is resent byte-for-byte, and data recorded after the
failure goes out in its own, later batch, never merged into the retained one.

**Setup:** Record evaluation set A. Script the stub: 503, 503, 200, 200.

**Steps and assertions:**

1. `advance(60000)` (tick 1). POST 0 carries A and gets 503.
   `retained_count == 1`.
2. Record evaluation set B (distinct keys from A).
3. `advance(60000)` (tick 2). The window holding B is serialized and appended
   behind the retained batch. The drain sends the oldest batch first: POST 1
   carries A and gets 503; the tick stops. `retained_count == 2`.
4. `advance(60000)` (tick 3). Record nothing new before this tick. POST 2
   carries A and gets 200; POST 3 carries B and gets 200.

**Assert:**

- `post_count == 4`.
- `sha256(body(0)) == sha256(body(1)) == sha256(body(2))`.
- `body(3)` contains the B evaluations and none of the A evaluations.
- `retained_count == 0` at the end.

## T3 - Non-retryable 4xx (P3)

**Goal:** Auth-type failures stop telemetry for the process; payload-type
failures drop one batch and carry on.

**Case a: 401.**

- Record evaluations. Build up one retained batch first (stub: 503 on tick 1),
  then script 401 for the next POST. Record more evaluations and
  `advance(60000)` (tick 2).
- Assert `log_count(ERROR, /401/) == 1`.
- Assert `telemetry_enabled() == false`.
- Assert `retained_count == 0` (the queue was dropped).
- Assert `log_count(WARN, /.*/) == 0` (auth failure is one ERROR, then
  silence).
- Record evaluations and `advance(60000)` three more times.
  `post_count` is unchanged and `log_count(ERROR, /.*/)` is still 1.

The same behavior applies to 403 and 404. SDKs should run case a as a
parameterized test over 401, 403 and 404.

**Case b: 400.**

- Record evaluations. Script 400 for POST 0, then 200. `advance(60000)`.
- Assert the batch is dropped: `retained_count == 0`.
- Assert `log_count(ERROR, /.*/) == 1`. This ERROR is the P7 drop signal for
  a non-retryable batch; the SDK does not log a separate WARN for the same
  batch: `log_count(WARN, /.*/) == 0`.
- Assert `telemetry_enabled() == true`.
- Record new evaluations and `advance(60000)`: `post_count == 2` (the next
  tick still posts), and `body(1)` is not equal to `body(0)`.

The same behavior applies to 413 and 422. SDKs should parameterize case b over
400, 413 and 422.

**Anti-vacuity:** 408 and 429 are 4xx but retryable. Add one case scripting
408 and asserting `retained_count == 1` and `telemetry_enabled() == true`, so
that a blanket "4xx is fatal" branch cannot pass.

## T4 - Retry-After and the 30s floor (P4)

**Goal:** A fast-ticking SDK does not hammer a failing server, and
`Retry-After` is honored and capped.

**Case a: the 30s floor.** Set the flush interval to 8s. Record evaluations.
Script the stub: 503 (no `Retry-After`), then 200.

- `advance(8000)`. POST 0 gets 503 at time F. `post_count == 1`.
- Advance in 8s steps. The ticks at F+8s, F+16s and F+24s send nothing:
  `post_count == 1` after each.
- The first tick at or after F+30s (F+32s with an 8s interval) sends:
  `post_count == 2` and `sha256(body(1)) == sha256(body(0))`.

**Case b: `Retry-After` honored.** Default 60s interval. Record evaluations.
Script the stub: 429 with `Retry-After: 120`, then 200.

- `advance(60000)`. POST 0 gets 429 at time F.
- Advance in tick-sized steps up to F+119s: `post_count == 1`.
- The first tick at or after F+120s sends the resend:
  `post_count == 2`, body identical to `body(0)`.

**Case c: `Retry-After` clamped to 600s.** Script 503 with
`Retry-After: 3600`, then 200. Record evaluations once before tick 1 and
again after the failure.

- POST 0 fails at time F. Advance in tick-sized steps up to F+599s:
  `post_count == 1`.
- The first tick at or after F+600s sends: `post_count == 2`.
- Because 600s is past the 5 min max age, the retained batch has already been
  discarded by then. So `body(1)` carries only the evaluations recorded after
  the failure, and the age discard produced exactly one WARN (P7).

`Retry-After` in delta-seconds form is required. The HTTP-date form should be
honored too, with the same 600s clamp. A `Retry-After` shorter than the 30s
floor does not shorten the floor.

## T5 - Caps under outage (P5, P6)

**Goal:** Nothing grows without bound during an outage.

**Queue caps.** Script sustained 503. For each of 8 ticks, record a distinct
set of evaluations E1..E8, then `advance(60000)`.

- `retained_count <= 5` and `retained_bytes <=` the byte cap (2097152 server, 524288 browser/mobile) after every tick.
- After tick 8, `retained_count == 5`.
- Script 200 and `advance(60000)` (tick 9, record nothing new). The drain
  sends exactly 5 POSTs, oldest-first, carrying E4, E5, E6, E7, E8 in that
  order: the batch with E1 is gone and the batch with E8 is present. Each
  resent body is byte-identical to the one first POSTed for that set, where
  one was POSTed (compare by sha256).

**Max age.** Fresh fixture. Script sustained 503. Record distinct evaluations
before each of ticks 1-3, then record nothing new and `advance(6 * 60_000)`
with the stub still failing.

- Batches older than 5 min are discarded: `retained_count == 0`.
- Script 200 and advance one tick: no POST carries any of the discarded
  batches.

**Oversize batch.** Set the byte cap to a small value (for example 4KB)
through its option, record enough distinct evaluations that the serialized
window is larger than the cap, and script 503.

- `advance(60000)`. The oversize batch is POSTed once (POST 0), gets 503,
  and is dropped, not retained: `retained_count == 0`,
  `retained_bytes == 0`.
- The drop counts for P7: `log_count(WARN, /.*/) == 1`.
- Separately, assert the shipped default byte cap: 2097152 for server SDKs,
  524288 for browser and mobile (P5).

**Aggregator caps.** For each aggregator the SDK has (evaluation summaries,
context shapes, example contexts, and the failover aggregator where present),
lower its cap through its option to a small N, then:

- Record N distinct keys, then more distinct keys beyond N.
- Keys beyond the cap are not recorded (drop newest): the next batch carries
  exactly N keys for that aggregator.
- Existing keys still increment: recording an already-present key after the
  cap is reached raises its count in the next batch.
- Assert each aggregator's shipped default cap equals the SDK's documented
  default and that the option exists.

## T6 - Logging episodes (P7)

**Goal:** One clear signal when telemetry is really losing data, silence when
it is not.

**Case a: a blip.** Record evaluations. Script one 503, then 200. Advance
through two ticks.

- `log_count(WARN, /.*/) == 0`.
- `log_count(INFO, /recover/i) == 1`.
- `log_count(DEBUG, /.*/) >= 1` (the failed POST).

**Case b: sustained failure, then recovery.** Script sustained 503. Record
distinct evaluations before every tick.

- Ticks 1-5 fill the queue: `log_count(WARN, /.*/) == 0`.
- Tick 6 evicts the oldest batch, the first drop:
  `log_count(WARN, /.*/) == 1`. That WARN includes the status, queue depth
  and dropped count.
- Every further drop within 10 min of that WARN logs at DEBUG only:
  `log_count(WARN, /.*/)` stays 1.
- Script 200 before the 10 min mark. The next tick drains the queue:
  `log_count(INFO, /recover/i) == 1`.

**Case c: WARN summary cadence.** As case b, but keep the stub failing and keep
dropping past 10 min from the first WARN.

- The first drop at or after 10 min from the first WARN emits exactly one
  more WARN, a summary carrying the count of drops since the previous WARN:
  `log_count(WARN, /.*/) == 2`.
- Continue dropping for less than another 10 min: still 2, no more.

**No ERROR in any case:** `log_count(ERROR, /.*/) == 0` throughout (5xx is not
an auth failure).

## T7 - One POST in flight (P2)

**Goal:** A slow server never causes overlapping POSTs, and skipped ticks lose
no data.

**Setup:** Record evaluation set A. Script POST 0 to hang until released.

**Steps and assertions:**

1. Tick. POST 0 carries A and hangs.
2. Record set B. Fire the tick again (call it directly, or use a flush
   interval under 5s so that two ticks land before the 15s timeout).
3. Record set C. Fire the tick again.
   - `post_count == 1`.
4. Release the stub with 200 for POST 0, before the 15s timeout.
5. Fire the next tick.
   - `post_count == 2`.
   - `body(1)` contains the evaluations from both skipped windows (B and C),
     and none from A.

## T8 - Shutdown (P8)

**Goal:** `close()` gives the live window one short chance, never drains the
retry queue, and never blocks exit.

**Setup:** Script 503 for two ticks with distinct evaluations, so that
`retained_count == 2`. Record a fresh set of evaluations in the live window.
Script the stub to hang for every further POST.

**Steps and assertions:**

1. Call `close()`. With a mocked clock, `advance(5000)` while `close()` is
   pending. SDKs whose `close()` cannot run against a mocked clock may use
   real time with a bound of 5s plus up to 1s of test slack.
   - `close()` has returned within 5s (virtual).
   - Exactly one more POST reached the stub: the final flush of the live
     window. Its body is not equal to either retained body.
   - No retained body was POSTed during `close()` (the retained queue is not
     drained).
2. After `close()`:
   - Advancing the clock further produces no more POSTs.
   - The process is not blocked: no telemetry thread, goroutine, timer or
     handle is left alive that would keep the process from exiting (Node: no
     active handles from the reporter; Go: the reporter goroutine has
     returned; Java/.NET: the executor or loop is stopped; Python/Ruby: the
     worker thread is joined or daemonized).
   - Calling `close()` a second time is a no-op and does not throw.

## Frontend and mobile

js/react and swift hand-mirror a subset in their own test suites, with the same
vocabulary and the same assertions, using their own defaults from the table
above.

- **sdk-javascript + sdk-react:** T1 (with the 10s browser timeout), T2, T3
  and T7, plus a **pagehide beacon check** in place of T8: on `pagehide` the
  SDK sends the live window once with `fetch(..., { keepalive: true })` or
  `navigator.sendBeacon`, bounded at 2s, and does not drain the retained
  queue.
- **sdk-swift:** T2, T3 and T5 against its disk queue. Retention stays on disk
  with the same caps (5 batches / 512KB) and the same 5 min age limit.

## Per-language hints

- **Go:** the stub is an `httptest.Server` whose handler pops the next scripted
  response from a slice or channel; hang by blocking on a release channel or
  on `r.Context().Done()`. The clock is an injected interface
  (`github.com/benbjohnson/clock` is the canonical fake, if it is already a
  dependency; otherwise a small hand-written fake). The logger is the SDK's
  logger interface backed by a slice of `(level, msg)`.
- **Node (vitest):** the stub is a `node:http` server on port 0, as in
  `test/failover-telemetry.test.ts`. Use `vi.useFakeTimers()` and
  `await vi.advanceTimersByTimeAsync(ms)` so real socket I/O can complete
  between fake timer steps. Hang by holding the `res` object until released.
- **Python (pytest):** the stub is a stdlib `http.server.ThreadingHTTPServer`
  on port 0 in a daemon thread. Clock via an injected `time_func` / monotonic
  function; `freezegun` or `time-machine` only if already a dev dependency.
  Capture logs with pytest's `caplog` at DEBUG.
- **Ruby (minitest):** a local WEBrick server, or WebMock stubs at the HTTP
  layer (not a fake connection object). Clock via `Timecop` or a
  `Process.clock_gettime` indirection. Capture logs with a `Logger` writing to
  a `StringIO`.
- **Java (JUnit):** the stub is the JDK's `com.sun.net.httpserver.HttpServer`
  or whatever `TelemetryReporterTest` already uses. Inject `java.time.Clock`
  and a controllable `ScheduledExecutorService`, or call the tick directly.
  Capture SLF4J output with the test logger the suite already uses.
- **C# (xUnit):** the stub is WireMock.Net, as in `HttpTelemetrySenderTests.cs`
  (supports status, headers and delays). Clock via an injected `TimeProvider`.
  Capture logs through an `ILogger` test sink.

Adding a new test dependency (for example `FakeTimeProvider`, WebMock) is a new
external dependency under the constitution; each SDK bead decides and records
it.

## Test runner conventions

| SDK        | Suggested test file                                                                         | Framework        |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------- |
| sdk-node   | `sdk-node/test/telemetry-transport.test.ts`                                                 | vitest           |
| sdk-go     | `sdk-go/telemetry_transport_test.go`                                                        | stdlib `testing` |
| sdk-python | `sdk-python/tests/unit/test_telemetry_transport.py`                                         | pytest           |
| sdk-ruby   | `sdk-ruby/test/test_telemetry_transport.rb`                                                 | minitest         |
| sdk-java   | `sdk-java/core/src/test/java/com/quonfig/sdk/telemetry/TelemetryTransportContractTest.java` | JUnit            |
| sdk-net    | `sdk-net/tests/Quonfig.Sdk.Tests/Telemetry/TelemetryTransportContractTests.cs`              | xUnit            |

Name each test after its number, for example
`TestTelemetryTransport_T1_TimeoutAbortsAndRetains` (Go) or
`T1 timeout aborts and retains` (vitest description).

## Acceptance

An SDK's implementation is accepted when:

1. Every contract test (T1-T8, or the subset for frontend and mobile) is green
   in that SDK's **normal CI test workflow**, not the chaos workflow.
2. The shipped defaults match the defaults table, and new options are
   documented in the SDK's README and CHANGELOG.
3. The wire format and public API are unchanged (P10), released as a semver
   minor.
4. The SDK is ticked off in the checklist below, in the same change that lands
   its tests, with a link to the commit or PR.

## Per-SDK checklist

sdk-node is the reference implementation and goes first; the other backend
SDKs copy its shape.

| SDK                        | Bead          | T1  | T2  | T3  | T4  | T5  | T6  | T7  | T8         | Notes                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------- | --- | --- | --- | --- | --- | --- | --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sdk-node (reference)       | `qfg-mol-9u0` | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x]        | [quonfig/sdk-node@3c1ba0c](https://github.com/quonfig/sdk-node/commit/3c1ba0c) (`test/telemetry-transport.test.ts`). Byte cap measured: 2MB (P5). Uses global `fetch`, which has no connect-timeout knob, so the 15s overall deadline also bounds connect/TLS and T1 asserts no separate connect option. |
| sdk-go                     | `qfg-y8je.6`  | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]        | Needs a telemetry logger; aggregators are uncapped today.                                                                                                                                                                                                                                                |
| sdk-python                 | `qfg-y8je.7`  | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]        | Needs an HTTP stub, an atexit flush (T8) and a shapes cap (T5).                                                                                                                                                                                                                                          |
| sdk-ruby                   | `qfg-y8je.8`  | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]        | Needs a real HTTP stub; explicit timeouts (Faraday defaults are 60s+60s).                                                                                                                                                                                                                                |
| sdk-java                   | `qfg-y8je.9`  | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]        | Audit `TelemetryReporterTest` first.                                                                                                                                                                                                                                                                     |
| sdk-net                    | `qfg-y8je.10` | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]        | T1 pins the timeout-kills-loop fix (`qfg-y8je.1`); `contextUploadMode` default moves to `periodic_example`.                                                                                                                                                                                              |
| sdk-javascript + sdk-react | `qfg-y8je.11` | [ ] | [ ] | [ ] | n/a | n/a | n/a | [ ] | beacon [ ] | Subset; T7 pins the shared-abort-timer fix.                                                                                                                                                                                                                                                              |
| sdk-swift                  | `qfg-y8je.12` | n/a | [ ] | [ ] | n/a | [ ] | n/a | n/a | n/a        | Subset, against the disk queue.                                                                                                                                                                                                                                                                          |

## Not doing

- No `tests/telemetry/transport.yaml`, no generator changes, no corpus edit.
- No chaos scenarios for now. If wanted later, a scriptable mock telemetry
  upstream plus a `telemetry` proxy in `start-chaos.sh` would also unblock
  `scenarios-http-proxy/08-auth-failure.yaml`.
- No client-side dedup key (P9).
- No attempt counter or exponential backoff (P4).

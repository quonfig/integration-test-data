# Tier 1 supervisor unit-test contract

A shared spec — no shared code. Every Quonfig backend SDK (`sdk-go`, `sdk-node`,
`sdk-python`, `sdk-ruby`, `sdk-java`, `sdk-net`) implements the tests below in
its own native test framework and language idiom. Each SDK team owns ~1-2 days of work.

Source plan: `project/plans/sdk-hardening-and-verification.md` section
"Tier 1 — Per-SDK supervisor unit tests".

Bead: `qfg-47c2.2`.

## What a "supervisor" means here

The supervisor is the in-SDK component that owns the long-lived worker
goroutine / thread / fiber that runs the SSE read loop (and, where applicable,
the HTTP polling fallback loop). It is the code path that:

- starts the worker when `client.start()` / constructor runs,
- detects worker exit (clean or abnormal),
- restarts the worker with an exponential backoff,
- bumps `worker_restart_total` on each restart,
- joins all workers cleanly on `client.close()`.

In `sdk-go` this is `sseClient.runLoop()` and the surrounding goroutine.
In `sdk-java` it is the `SseClient` background executor wired into
`activeBody`. Each SDK has its own naming — the contract tests describe
*behavior*, not file paths.

## How to set up the test fixture

Every SDK should expose, behind a test-only seam, the ability to inject a
**fake worker** whose behavior is scripted by the test. The supervisor under
test does not know it is talking to a fake. Concretely:

- The worker is a callable / functional interface / interface implementation
  the supervisor would normally drive (e.g. "open SSE connection, read frames
  until error, return").
- The fake replaces the real network-driven worker so the test does not need
  a server, sockets, or toxiproxy. Tier 2 covers the network path; Tier 1
  covers the supervisor logic in isolation.
- The fake exposes counters and a script — "throw on attempt 1, sleep then
  return cleanly on attempt 2", etc.
- Time is **mocked or compressed**: tests must not actually sleep 30s. Either
  inject a clock (`Clock` interface in Go/Java/C#, `freezegun`/`time-machine`
  in Python, `Timecop` in Ruby, `jest.useFakeTimers` in Node) or accept that
  the supervisor takes a backoff function the test can override to return
  near-zero durations while still asserting the *requested* backoff value.

The test fixture should NOT mock the supervisor itself — that defeats the
test. Mock only the worker and the clock.

**Exception, Test 8 only: a fake config fetch.** Test 8 also replaces the
config fetch legs (the hedged or failed-over HTTP fetch the fallback poller
and polling mode run) with a fake. It takes a per-leg script of
`(status, envelope valid or not)` for each fetch cycle, and counts cycles and
the legs each cycle asked, so every SDK stubs the legs the same way. The
log capture marks the point where the client enters auth-failed, so Test 8
(c) can count log lines from there. Everything else (the supervisor, the
fallback-poller schedule, the auth-failed state machine) stays real.

**Exception, Test 9 only: the real worker against a local server.** The
first-frame rule lives in the worker's frame handling, so Test 9 does not
fake the worker. It drives the SDK's real SSE worker against a local HTTP
server on 127.0.0.1 built from the language's stdlib or existing test
dependencies (no toxiproxy, no fault proxy, no new dependency). Only the
fallback threshold/interval is shrunk, through the SDK's existing option or
test seam. Test 10 (size caps) uses the same local-server fixture.

## Common assertion vocabulary

Tests reference these capabilities; each SDK names them per language idiom
but the meaning is fixed:

| Capability | Meaning |
|---|---|
| `worker_restart_total` | Counter incremented only when the supervisor actually restarts a worker after abnormal exit (`layer="1"`: the SSE worker reconnects after its connection ended abnormally; `layer="2"`: the fallback-poller worker is restarted). Never incremented by a user callback throw (see `callback_errors_total`). Reset to 0 at supervisor start. Exposed via the same Prometheus-style metric the SDK exports in production. |
| `callback_errors_total` | `quonfig_sdk_callback_errors_total{callback}`, `callback` in {`on_config_update`, `on_connection_state_change`}. Incremented by 1 for each user callback invocation that throws / panics / raises and is caught by the SDK. Same visibility as `worker_restart_total` in that SDK (an internal test seam; a public reader only where the SDK already has a public diagnostic surface). Reset to 0 at client start. (qfg-6vno.25) |
| `lastSuccessfulRefresh()` | Wall-clock timestamp (UTC) of the most recent successful refresh — the last time the SDK confirmed its config source reachable and its held config current. A LIVENESS signal, not an install counter (qfg-41nh.11): advanced by any envelope install AND by a config fetch that completed successfully without installing — a 304 Not Modified, a 200 the reject-older guard dropped as equal-or-older, or a received-and-processed SSE message that was a guard no-op. Transport errors never advance it. Returns null / zero / None before the first successful refresh. |
| `connectionState()` | Returns one of: `initializing`, `connected`, `disconnected`, `falling_back`. Documented values are fixed; SDKs may not invent new strings. |
| `client.close()` | Public shutdown method. Stops the supervisor, joins all workers, releases resources. Idempotent. |
| auth class -> `auth-failed` | HTTP **401, 403, 404, 410** on a config fetch leg is the *auth class*. A fetch cycle in which **no leg returned 200/304 and the primary (first) leg returned an auth-class status** puts the client in the internal **auth-failed** regime (Test 8). Every other status keeps its transient handling. An SSE response is never classified: SSE alone never enters auth-failed. `auth-failed` is NOT a `connectionState()` value: while in it the client reports `disconnected`. |

These names are the *contract* — the SDK can map them to idiomatic names
(`LastSuccessfulRefresh()` in Go, `last_successful_refresh` in Python,
`#lastSuccessfulRefresh()` in Java) but the semantics must match.

## Rule — a connection is `connected` at its first valid frame

A stream connection counts as connected only after it delivers its **first
valid frame**. Only at that moment may the SDK (1) reset its reconnect
backoff to the initial delay, (2) cancel the fallback poller's engage timer
or disengage an engaged poller, and (3) report `connected` via
`connectionState()` and its SSE state-change callback.

- **Valid frame:** a complete SSE event block, terminated by a blank line,
  that is either comment-only (the server keepalive, `: keepalive`) or a
  `data:` block that decodes and validates as a config envelope.
- **Not a frame:** 200 response headers alone; a block cut off by EOF; a
  malformed or non-envelope `data:` block; an oversized event (see Rule —
  size caps).
- **Failed attempt:** a connection that ends (EOF, IO error, read watchdog)
  before its first valid frame. It MUST be handled exactly like a connect
  error: backoff grows, the SDK reports a not-connected state, and the
  engage timer is armed (if not already) and not cancelled.
- Between the 200 headers and the first frame the SDK keeps the state it
  had before the attempt. No new state value.
- A keepalive does NOT advance `lastSuccessfulRefresh()`; only the events in
  the vocabulary table above do.
- A connection that did deliver a frame and then ends with a clean EOF (the
  normal load-balancer recycle) still reconnects with a reset backoff. This
  rule changes only connections that end before their first frame.

**Bounded transparent reconnect (sdk-python, sdk-ruby; Jeff, 2026-10-16).**
These two SDKs keep reporting `connected` across a reconnect after a clean
EOF, with no state edge, so an ordinary load-balancer recycle stays
invisible. The hold is bounded by the very next connection: it either
delivers its first valid frame (stay `connected`, still no edge) or it is a
failed attempt (report the not-connected state at once, grow the backoff
and arm the engage timer). `connected` may never be held across two
consecutive connections that deliver no frame. Every other SDK (go, node,
java, net) reports the not-connected edge on every connection end, as
before.

Why "first frame" and not "first envelope": a workspace that is not yet in
the server's cache sends no snapshot, and its first frame is the 30 s
keepalive. Why not "200 headers": a server or proxy that answers 200 and
closes would otherwise reset the backoff and cancel the fallback poller on
every attempt — a reconnect storm with frozen config (qfg-goi1.10.9).
Against Quonfig's own servers the 200 headers and the first frame arrive in
the same write, so the only new delay there is parsing that frame.

## Rule — size caps (all backend SDKs; qfg-6vno.8)

Plan: `project/plans/2026-10-22-sse-body-size-caps.md`, approved by Jeff
2026-10-22. Applies to go, node, python, ruby, java and net. sdk-javascript
and sdk-swift (and sdk-react / sdk-react-native over sdk-javascript) are out
of scope: their payload is a per-context evaluation for one user and they have
no SSE.

| Input | Cap | Over the cap |
|---|---|---|
| One SSE event (any line; SDKs that join multi-line `data:` SHOULD cap the sum) | 4 MiB (4,194,304 bytes) | Not a frame. The connection is a failed attempt. |
| HTTP 200 body from `/api/v2/configs` | 16 MiB (16,777,216 bytes) | A failed leg, exactly like a 5xx. |
| Non-2xx body | read at most 1 KiB | Never logged, never in an error message. |

- Memory per stream or request stays bounded near the cap, even for an
  event with no line terminator. Stop reading at the cap; do not read all
  of it and then compare.
- Overflow never installs anything, never stores an ETag and never advances
  `lastSuccessfulRefresh()`. A failed attempt or failed leg backs off as
  usual (Test 2's ladder; the hedge/failover legs proceed as for a 5xx).
- After an oversized SSE event, a connection that delivers only that event
  again never reports `connected` (backoff keeps growing and the fallback
  poller engages). A keepalive alone does not clear this; the first
  installed envelope does.
- One WARN per oversized episode naming the source (redacted) and the cap
  in bytes; repeats at DEBUG. The episode ends at the next installed
  envelope from that source.
- The caps are constants, not options.

## Test 1 — Restart on worker throw within 1000ms

**Goal:** Supervisor detects abnormal worker exit and restarts the worker.

**Setup:**

- Inject a fake worker that throws (panics / raises / rejects) on its first
  call. On the second call, it blocks until the test ends, simulating a
  healthy long-lived connection.
- Start the supervisor.

**Assert:**

- Within **1000ms** (test-configurable knob — wall-clock for real-time tests,
  virtual time for mocked-clock tests), the worker has been invoked a second
  time.
- The supervisor itself is still alive (no exception escaped to the test).

**Why 1000ms:** Real backoff starts at 500ms (see Test 2). 1000ms gives
the first restart cycle time to complete with margin. The 1000ms ceiling is
configurable in tests so a slow CI runner does not flake — but it must NOT be
configurable in production code.

**Per-language hints:**

- **Go:** fake worker is a `func() error` that returns a sentinel error
  the first time. The supervisor's restart path should `recover()` if the
  fake panics, but `error` return is the normal case. Use `chan struct{}`
  to signal the second call.
- **Java:** fake worker is a `Runnable` or `Callable` that throws a
  `RuntimeException`. Use `CountDownLatch` to detect the second call.
- **Python:** fake worker is a callable that raises `RuntimeError`. Use
  `threading.Event` or `asyncio.Event` depending on the SDK's concurrency
  model.
- **Ruby:** fake worker is a `Proc` that raises `StandardError`. Use a
  `Queue` to signal the second call.
- **Node:** fake worker is an `async () => {...}` that throws. Use a
  `Promise` resolver to detect the second call.

## Test 2 — Exponential backoff to 30s cap

**Goal:** Supervisor backs off exponentially after repeated worker failures.

**Sequence (target):** 500ms, 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s, ...

**Setup:**

- Inject a fake worker that always fails immediately on every call.
- Capture the requested backoff duration for each restart — either by
  intercepting the sleep/timer call via the test clock or by exposing a
  test-only hook on the supervisor that records the backoff value before
  sleeping.
- Run the supervisor through at least 8 restart cycles. Use a mocked clock so
  the test completes in <1s of wall-clock time.

**Assert:**

For restarts 1 through 8, the requested backoff durations match (within +/-
10% jitter tolerance if the SDK adds jitter — most should):

```
restart 1: 500ms
restart 2: 1000ms
restart 3: 2000ms
restart 4: 4000ms
restart 5: 8000ms
restart 6: 16000ms
restart 7: 30000ms   (cap)
restart 8: 30000ms   (cap)
```

**Jitter:** SDKs MAY add up to +/- 20% jitter to each backoff to avoid
thundering-herd reconnects after a partition heal. If jitter is added,
the test asserts the unjittered base value and tolerates the band.

**Reset:** A *successful* worker run (one that delivered at least one valid
frame — an envelope or a keepalive — before exiting; see "Rule — a
connection is `connected` at its first valid frame") MUST reset the backoff
counter to 500ms for the next failure. Add a parallel sub-test for this:

- Worker 1: fails.
- Worker 2 (500ms later): runs successfully, delivers an envelope, then exits
  cleanly after 5s.
- Worker 3 starts: backoff should be **500ms again**, not 1000ms.
- Worker 2 variant: returns 200 and exits with no frame. Worker 3's backoff
  MUST be 1000ms (grown), not 500ms.

**Per-language hints:**

- **Go:** `time.AfterFunc` or a `clock.Clock` interface. The
  `github.com/benbjohnson/clock` library is the canonical fake.
- **Java:** `java.time.Clock` injected via constructor, plus a mocked
  `ScheduledExecutorService`.
- **Python:** `freezegun` or pass a `time_func` to the supervisor.
- **Ruby:** `Timecop.freeze` or `Process.clock_gettime` indirection.
- **Node:** `jest.useFakeTimers()` or `sinon.useFakeTimers()`.

## Test 3 — Clean shutdown within 5s

**Goal:** `client.close()` joins all worker threads within a 5s deadline.

**Setup:**

- Start the supervisor with a worker that runs forever (blocks reading from
  a channel / queue that the test never writes to).
- After the supervisor is fully started and the worker has been invoked
  at least once, call `client.close()`.

**Assert:**

- `client.close()` returns within **5000ms** wall-clock.
- The worker function has returned (any internal `joined` flag is set, the
  thread/goroutine/coroutine is no longer running).
- Calling `client.close()` a second time is a no-op and does not throw.
- After close, calling `connectionState()` returns `disconnected` (not
  `connected` and not a new state).

**Per-language hints:**

- **Go:** the supervisor must propagate a `context.Context` cancel signal to
  the worker. The worker must respect ctx — sleeping on a bare
  `time.Sleep` without selecting on `ctx.Done()` is a bug this test should
  catch. Reference: `sdk-go/sse_client.go` uses `select` on `ctx.Done()`.
- **Java:** the supervisor uses `Future.cancel(true)` plus `interrupt()` to
  unblock the worker. Test that `Thread.isInterrupted()` is honored.
- **Python:** for threading-based SDKs, set a `threading.Event` the worker
  selects on; for asyncio SDKs, call `task.cancel()` and assert
  `CancelledError` propagates.
- **Ruby:** the supervisor sends a signal to the worker thread (raise
  `Quonfig::Shutdown` inside the thread via `Thread#raise`). Test the worker
  catches and returns.
- **Node:** the supervisor calls `AbortController#abort()` on the worker's
  signal. Test the worker observes `signal.aborted`.

This test matches `SseClient.stop()` behavior in `sdk-java` and `sdk-go`
today — it is a regression test for an already-shipped contract.

## Test 4 — `worker_restart_total` counter

**Goal:** The `worker_restart_total` Prometheus-style counter exposed by the
SDK increments by exactly 1 per restart.

**Setup:**

- Read the counter's initial value (should be 0).
- Inject a fake worker that fails 3 times, then runs forever.
- Use a mocked clock so the test does not actually wait through the 500ms +
  1s + 2s backoffs.

**Assert:**

- After all 3 restarts have occurred, the counter is exactly **3**.
- The counter has the expected labels per the plan's server-side metric spec:
  `sdk`, `sdk_version`, `layer` (where `layer="1"` for SSE and `layer="2"`
  for HTTP polling). An optional `reason` label (today only sdk-go sets it,
  on `layer="1"`) is one of: `connect_failed` (the attempt failed before the
  stream delivered a valid frame) or `stream_ended` (an established stream
  ended: EOF, IO error or read timeout). A user callback throw is never a
  restart reason (Test 5).
- The counter must be readable via whatever Prometheus / metrics endpoint
  the SDK exposes — test reads it the same way a real scraper would.

**Why a separate test from Test 1:** Test 1 asserts the *behavior* (restart
happens). Test 4 asserts the *observability* (the metric exists, has the
right labels, increments correctly). A bug that makes the SDK restart
silently with no metric is just as bad as one that fails to restart at all,
because operators won't see it.

**Per-language hints:**

- **Go:** SDKs use `prometheus.Counter` from `github.com/prometheus/client_golang`.
  Read the value via `testutil.ToFloat64`.
- **Java:** `io.prometheus.client.Counter`. Read via `Counter#get()`.
- **Python:** `prometheus_client.Counter`. Read via `_value.get()` or via
  the registry's `collect()` method.
- **Ruby:** `prometheus-client` gem. Read via `Counter#get(labels:)`.
- **Node:** `prom-client`'s `Counter`. Read via `counter.get()`.

## Test 5 — Callback-throw isolation (all backend SDKs)

**Applies to:** every backend SDK (go, node, java, python, ruby, net).
REQUIRED. Decision: Jeff 2026-10-22 (bead `qfg-6vno.25`).

**Goal:** A throw / panic / raise from a user callback (`on_config_update`,
`on_connection_state_change`) is caught by the SDK, counted in
`callback_errors_total`, logged at ERROR, and is NOT a worker restart. The
SDK keeps processing envelopes.

**The rule under test:**

- The SDK catches the language's ordinary exception class only (Go:
  `recover()`; Java: `Exception`; Python: `Exception`; Ruby:
  `StandardError`; Node: a thrown error or a rejected promise; .NET:
  `Exception`).
- `quonfig_sdk_callback_errors_total{callback}` increments by 1 per caught
  throw. `worker_restart_total` does not change: no worker was restarted.
- The throw is logged at ERROR with the exception value and stack; the
  message names the callback (matches `/callback|onConfigUpdate/i`).
- No change to `connectionState()`, `lastSuccessfulRefresh()` or the
  OpenFeature provider status. Remaining listeners still run.

**Setup:**

- Configure the SDK with an `on_config_update` callback that throws on its
  first invocation, then succeeds on subsequent invocations.
- Feed the SDK a fake stream that emits two valid envelopes back-to-back.
  (Either via a unit-level fake `parseStream` input, or via a local test
  server.)
- Repeat with an `on_connection_state_change` callback that throws on its
  first invocation.

**Assert (per callback):**

- After the one throw, `callback_errors_total{callback="on_config_update"}`
  (or `"on_connection_state_change"`) is exactly **1**.
- `worker_restart_total` is unchanged across the throw (delta 0, every
  layer).
- The next envelope is still delivered: the second envelope is installed,
  and the callback runs again (and succeeds) on its next trigger.
- An ERROR log line contains the user's exception message and stack trace.
- `connectionState()` and `lastSuccessfulRefresh()` are exactly what they
  would be without the throw.

**Per-language hints:**

- **Go:** `defer func() { if r := recover(); r != nil { ... } }()` wrapped
  around the user callback. The recover must log via the SDK's configured
  logger, not stderr directly, and must not call the restart counter.
- **Java:** `try/catch (Exception e)` around the user callback (not
  `Throwable`: an `Error` is not an ordinary exception).
- **Python:** `try / except Exception` (NOT bare `except` — let
  `KeyboardInterrupt` and `SystemExit` propagate). Log via
  `logger.exception()` so the traceback is preserved.
- **Ruby:** `rescue StandardError` (NOT `rescue Exception` — same reason
  as Python). Log via `logger.error` with `e.full_message`.
- **Node:** wrap the `await onEnvelope(...)` in `try { } catch (err) { }`.
  Promise rejection from an async callback must be awaited and caught;
  unhandled rejections would crash the process under
  `--unhandled-rejections=strict`.
- **.NET:** `try { } catch (Exception ex)` around the handler invocation;
  log at Error, not Warning.

## Test 6 — `lastSuccessfulRefresh()` and `connectionState()` transitions

**Goal:** Both getters expose the documented state correctly across the full
connect/disconnect/reconnect lifecycle.

**Setup:**

- Inject a fake worker that the test can drive through three phases:
  1. Connect successfully and deliver one envelope.
  2. Disconnect (return from the worker function — supervisor will restart).
  3. After 2 restart attempts, deliver a second envelope and stay healthy.

**Assert — `connectionState()`:**

State transitions, captured by polling or via a state-change listener:

```
t=0 (before start)         : initializing
t=after start, before conn : initializing
t=after 200 headers, no frame : initializing   (unchanged: not connected)
t=after first valid frame     : connected
t=after worker exit        : disconnected
t=after fallback engages*  : falling_back   (* only if SDK has HTTP fallback)
t=after reconnect succeeds : connected
t=after client.close()     : disconnected
```

Each documented value MUST appear in the transition log at some point if
the SDK supports it. SDKs without HTTP fallback (e.g. a fictional
SSE-only minimal SDK) skip the `falling_back` assertion. **No SDK may
emit a state value not in the documented set.**

**Diagnostics must not lie:** after any transport teardown that is *not*
`close()` — a fork hook dropping inherited state, a manual pre-fork call, a
supervisor restart — `connectionState()` MUST NOT return `connected` until a
fresh connection or refresh has actually succeeded *in this process*. A stored
state flag must never outlive the component it describes. (sdk-ruby 1.3.0
answered `:connected` for 13 days from a parent whose stream had been torn
down by its own fork hook — qfg-lv4n.)

**Assert — `lastSuccessfulRefresh()`:**

- Before any envelope is delivered: returns null / zero / None.
- After the first envelope is installed in the cache: returns a wall-clock
  timestamp within 1s of `now()`.
- After the second envelope is installed: returns an updated wall-clock
  timestamp that is `>` the first one.
- After `client.close()`: the value is preserved (close does not zero out
  the timestamp).

**Wall-clock semantics:** The timestamp is a LIVENESS signal — the last
moment the SDK confirmed its config source reachable and its held config
current (qfg-41nh.11). An install always advances it (this test drives two
installs and asserts the second stamp is `>` the first), but so does a
config fetch that completed successfully *without* installing: a 304 Not
Modified, a 200 the reject-older guard dropped as equal-or-older, or a
received-and-processed SSE message that was a guard no-op. Transport
errors never advance it. This is what lets a healthy long-lived client
parked on 304s keep reporting liveness rather than freezing the stamp at
its last install (chaos scenario 05 asserts the continuous-freshness hold
across the Layer 2 fallback poll cycle).

**Liveness-probe warning:** The doc comment / Javadoc / Rubydoc on this
getter MUST include the warning from the plan ("don't wire this into a
Kubernetes liveness probe — a stuck refresh is not a liveness signal").
The test asserts the presence of the warning string in the symbol's
documentation where the SDK's tooling supports introspecting docstrings
(Python, Ruby). For SDKs without runtime docstring access (Go, Java),
the test instead checks a lint rule or a separate `README_check`.

**Per-language hints:**

- **Go:** `LastSuccessfulRefresh() time.Time` returning the zero value
  before first install. `ConnectionState() ConnectionState` where
  `ConnectionState` is a typed string. Use a `sync.RWMutex` for thread-safe
  reads.
- **Java:** `public Optional<Instant> lastSuccessfulRefresh()` and
  `public ConnectionState connectionState()` (an enum). Java's enum
  gives compile-time checking that no SDK invents a new state value.
- **Python:** `def last_successful_refresh(self) -> Optional[datetime]`
  and `def connection_state(self) -> ConnectionState` (an `enum.Enum`).
- **Ruby:** `def last_successful_refresh -> Time | nil` and
  `def connection_state -> Symbol` returning one of `:initializing`,
  `:connected`, `:disconnected`, `:falling_back`.
- **Node:** `lastSuccessfulRefresh(): Date | null` and
  `connectionState(): 'initializing' | 'connected' | 'disconnected' | 'falling_back'`
  using a TypeScript string-literal union for compile-time checking.

## Test 7 — Fork transparency (sdk-ruby, sdk-python; others N/A)

**Applies to:** SDKs whose runtime exposes `fork(2)` and that install an
automatic fork hook: sdk-ruby (`Process._fork`, Ruby 3.1+) and sdk-python
(`os.register_at_fork`). Go, Java, .NET and Node mark this test N/A.

**Goal:** A fork is invisible to the parent, and the child becomes a fully
independent client on its first use. Neither process can go silently stale.
This is the Reforge model (parent never touched; child drops inherited state
in the hook and re-initializes lazily with a fresh empty store, its own fetch,
its own stream, its own telemetry reporter). See epic qfg-lv4n.

**Setup:**

- A connected client (fake SSE server, or poll-as-primary) that has installed
  at least one envelope.
- Fork a child. Parent and child both keep running. The child uses the client
  (evaluates at least once) after the fork.

**Assert:**

- A NEW envelope published after the fork is received by BOTH the parent and
  the child within 5s, and `get(key)` in both processes reflects it.
- The parent's transport worker (thread / object identity) is unchanged across
  the fork. The parent performs no teardown, reconnect, or re-fetch because of
  the fork.
- `connectionState()` in both processes reflects reality at every point: never
  `connected` while no transport component is alive in that process. A child
  that has not yet re-initialized reports `initializing` until its first use.
- Telemetry: the parent keeps reporting; the child reports only data generated
  after the fork, under its own instance hash (no re-send of inherited
  buffers).
- `close()` returns within 5s in the child, whether or not it ever used the
  client.

**Anti-vacuity rule:** the parent-side assertion MUST be made through a
delivered envelope, never through `connectionState()` alone. sdk-ruby's
pre-1.4.0 fork test asserted the parent via `connectionState()` and passed for
four months while the parent was dark.

**Reference implementations:** `sdk-ruby/test/test_fork_safety.rb` (1.4.0)
and `sdk-python/tests/unit/test_forking.py` (1.4.0).

## Test 8 — Auth-class response (all backend SDKs)

**Applies to:** every backend SDK (go, node, python, ruby, java, net). Plan:
`project/plans/2026-10-07-sdk-auth-failure-rule.md` section 4 (rule R1-R6),
approved by Jeff 2026-10-09 (bead `qfg-goi1.4`). This is the gate for the
auth-failure rule until chaos scenario
`scenarios-http-proxy/08-auth-failure.yaml` becomes runnable (it needs an
HTTP-aware fault proxy, WS4; not built yet).

**Goal:** A rejected key never latches, never tight-loops and logs one
config ERROR. While auth-failed the client sends one slow fetch probe per
auth period and leaves on the first valid answer.

**The rule under test (R1-R6):**

- **R1 Auth class.** 401, 403, 404, 410 on a config fetch leg. Every other
  status keeps its current transient handling.
- **R2 Entry, poll-driven.** Only a fetch cycle the SDK already runs can
  enter: the fallback poller's cycle (engaged on the SDK's existing rule) or
  a poll in polling mode. It enters auth-failed when **no leg returned
  200/304 and the primary leg returned an auth-class status**. Primary
  auth-class + secondary 503 or timeout enters; primary 503 + secondary
  auth-class does not. A single-leg client's only leg is the primary. A
  cycle with a 200/304 on any leg installs and stays in the normal regime.
  **SSE does not change before entry:** an SSE 401/403/404/410 keeps the
  SDK's normal reconnect ladder and log line, and never enters auth-failed
  by itself.
- **R3 While auth-failed.** SSE is not attempted and the fallback poller does
  not run. The client sends **one probe per auth period T, uniform in
  [150s, 300s]**, for as long as the process lives: no doubling, **no
  latch**. A probe is one fetch cycle across every configured leg. In
  polling mode the wait is `max(T, poll interval)`. T is an internal test
  seam, never a customer option.
- **R4 Exit.** The first probe that gets a 200 with a valid envelope, or a
  304, on any leg: the client installs it, leaves auth-failed, and SSE
  restarts from its normal base backoff. This is the only way out.
- **R5 Logging.** Before entry, unchanged (each SDK logs SSE and poller
  failures as today, never at ERROR; sdk-ruby gives an SSE 401/403/404/410
  a WARN once per status, re-armed by a 200, DEBUG otherwise). On entry:
  **one config ERROR** from the entering cycle, in place of its usual
  failure line, naming the status and the host and never the key. Each
  probe: DEBUG only. On exit: one INFO.
- **R6 State.** `connectionState()` is `disconnected` while auth-failed,
  never `falling_back`. No new state string. No new getter (sdk-ruby keeps
  `terminal_failure?`, meaning "auth-failed now").

**Setup:**

- Fake worker (SSE), fake config fetch (see "How to set up the test
  fixture") and mocked clock. Two legs (primary, secondary) unless a
  sub-test says otherwise.
- Run every sub-test parameterized over **401, 403, 404, 410**.

**Assert:**

- **(a) Entry and probe cadence.** The SSE worker gets auth-class responses;
  then the fallback poller (engaged on the SDK's existing rule) gets
  auth-class on every leg. Before that cycle, SSE attempts are requested at
  the SDK's normal ladder (the waits its Test 2 implementation requests)
  and no fetch cycle runs. After it the client is auth-failed, and the next
  **6 probes** are each requested at a wait in **[150s, 300s]**. No
  doubling, no stop.
- **(b) While auth-failed.** No SSE attempt; the fallback poller never
  engages; each probe is one fetch cycle across the configured legs;
  `connectionState()` is `disconnected` throughout, never `falling_back`.
- **(c) Logging.** Counting from entry through the 6 probes: exactly one
  `log_count(ERROR, /401|403|404|410/)` (the entering cycle's line), no
  other ERROR, and no WARN. Logs before entry are not asserted (R5).
- **(d) Exit.** A probe gets a 200 with a valid envelope on the **secondary
  leg only**: the client installs it, exits, logs one INFO, and SSE
  restarts. The next ordinary SSE failure requests the SDK's normal first
  backoff (the one its Test 2 implementation requests). A 304 on any leg
  exits the same way.
- **(e) Transient primary rejection.** SSE auth-class, then a poller cycle
  with a 200 on any leg: no auth-failed and no ERROR. SSE keeps the normal
  ladder (its next attempt is requested at the SDK's Test 2 wait) and the
  poller keeps its normal interval.
- **(f) Mixed legs.** Primary auth-class + secondary 503 (or timeout) enters
  auth-failed. Primary 503 + secondary auth-class does not, and follows the
  normal ladder.
- **(g) Non-auth status.** A 503 on every leg follows the normal ladder
  (Test 2 unchanged) and never enters auth-failed.

**Anti-vacuity rule:** (a) and (d) MUST assert the *requested* wait values
from the clock or backoff hook, not only that a probe eventually ran; a
client that probes every 60s passes "a probe ran" and fails (a).

**Per-language hints:** the clock hooks of Test 2 apply. The fake fetch is a
per-leg function returning `(status, body)`; record each call with its leg
index and the clock time.

## Test 9 — First-frame rule against a local server (all SSE SDKs)

**Applies to:** every backend SDK with SSE (go, node, python, ruby, java,
net). Plan: `project/plans/2026-10-12-sse-connected-first-frame.md`, approved
by Jeff 2026-10-16 (bead `qfg-goi1.10.9`). Unlike Tests 1-6 this test drives
the **real** SSE worker against a local HTTP server on 127.0.0.1 (see "How to
set up the test fixture"), because the rule lives in the worker's frame
handling. Use only the language's stdlib or existing test dependencies; no
toxiproxy, no fault proxy. Shrink the fallback threshold/interval through
the SDK's existing option or test seam. The server's config-fetch endpoint
serves envelope v2; the client's init fetch got v1.

**The rule under test:** "Rule — a connection is `connected` at its first
valid frame" above, including the bounded transparent reconnect for
sdk-python and sdk-ruby.

**9a — headers only.** Every SSE attempt: 200 + `text/event-stream`
headers, flush, close.
- No `connected` edge is ever reported; `connectionState()` is never
  `connected`.
- The requested backoff grows across attempts (Test 2's ladder).
- The fallback poller engages after the threshold: `connectionState()` is
  `falling_back` and `get` returns v2.

**9b — headers early, frame late.** 200 + headers, flush, wait 1s, send
`: keepalive\n\n`, hold the stream open.
- Exactly one `connected` edge, reported no earlier than the keepalive
  (edge time >= send time - 50ms).

**9c — one keepalive then close.** Every attempt: 200 + `: keepalive\n\n`,
close.
- One `connected` edge per attempt (sdk-python and sdk-ruby: `connected`
  held across the reconnects, per the bounded transparent reconnect); the
  requested backoff stays at the initial delay; the poller does not engage
  within the threshold.

**9d — control.** 200 + a snapshot envelope, hold the stream open: one
`connected` edge, unchanged from today.

**Anti-vacuity:** 9a MUST assert through the fallback-delivered value (v2),
not through `connectionState()` alone, and the test MUST be shown red on
the pre-fix SDK (9a or 9b; sdk-ruby: 9a or 9c).

**Existing fakes:** audit the SDK's other tests for fake servers that flush
200 and then idle before sending anything (header-timeout, state-order and
callback tests). Under this rule they no longer report `connected` on
headers and must send a frame first.

## Test 10 — Size caps (all backend SDKs)

**Applies to:** every backend SDK (go, node, python, ruby, java, net). Plan:
`project/plans/2026-10-22-sse-body-size-caps.md`, approved by Jeff
2026-10-22 (bead `qfg-6vno.8`). **The rule under test:** "Rule — size caps"
above.

Local server, same fixture as Test 9.
1. SSE serves `id: g2` + `data:` with a valid-JSON envelope padded to
   4 MiB + 1 byte, then holds the stream open; `/api/v2/configs` serves a
   small valid envelope. Assert within 10 s: at least 2 SSE connects with
   growing gaps, `connectionState()` never `connected`, the fallback poller
   fetched `/api/v2/configs`, exactly one WARN containing `4194304`.
2. SSE serves `data: ` followed by 8 MiB with no newline. Assert the
   connection ends and is retried with backoff, and (where the language can
   measure it) the process did not buffer more than about 5 MiB for it.
3. `/api/v2/configs` returns 200 with a 16 MiB + 1 byte body (and a run
   with no `Content-Length`). Assert the leg failed, nothing installed,
   no ETag stored, the next request sends no `If-None-Match` from it.
4. `/api/v2/configs` returns 502 with a 2 MiB body containing a marker
   string. Assert no log line or error message contains the marker.
5. Control: an envelope of 3 MiB over SSE and 12 MiB over HTTP installs.

No YAML corpus change: this is a transport contract, tested by per-SDK unit
tests against a local server, like Tests 8 and 9.

## Test runner conventions

Each SDK places these tests in its own test directory, run by its own
test framework, named consistently:

| SDK | Test file path | Framework |
|---|---|---|
| sdk-go | `sdk-go/supervisor_test.go` | stdlib `testing` |
| sdk-node | `sdk-node/test/supervisor.test.ts` | jest |
| sdk-python | `sdk-python/tests/test_supervisor.py` | pytest |
| sdk-ruby | `sdk-ruby/spec/supervisor_spec.rb` | rspec |
| sdk-java | `sdk-java/src/test/java/.../SupervisorTest.java` | JUnit 5 |
| sdk-net | `sdk-net/tests/Quonfig.Sdk.Tests/Supervisor/SupervisorTests.cs` | xUnit |

Each test should be named after its number above, e.g.
`TestSupervisor_RestartsWorkerWithin1000ms` (Go),
`supervisor restarts worker within 1000ms` (Node/jest description).

## Acceptance for this contract

A Tier 1 implementation is accepted when:

1. Tests 1-6, 8, 9 and 10 run green in the SDK's CI (plus Test 7 where
   applicable; Test 7 is N/A for go, node, java and net).
2. The SDK exposes `worker_restart_total`, `callback_errors_total`,
   `lastSuccessfulRefresh()`, `connectionState()` per the contract.
3. The SDK's `connectionState()` only returns documented values.
4. The PR description in the SDK repo links back to this doc and to the
   parent bead `qfg-47c2`.

## Estimated effort

Per the plan: **1-2 engineer-days per SDK**. The largest variance is
clock injection — SDKs that already have a `Clock` seam (sdk-go via
`time.Now` wrappers, sdk-java via `Clock` parameter) finish faster than
SDKs that need to retrofit one (sdk-ruby, sdk-python).

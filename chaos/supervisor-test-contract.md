# Tier 1 supervisor unit-test contract

A shared spec — no shared code. Every Quonfig backend SDK (`sdk-go`, `sdk-node`,
`sdk-python`, `sdk-ruby`, `sdk-java`) implements the six tests below in its own
native test framework and language idiom. Each SDK team owns ~1-2 days of work.

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

## Common assertion vocabulary

Tests reference these capabilities; each SDK names them per language idiom
but the meaning is fixed:

| Capability | Meaning |
|---|---|
| `worker_restart_total` | Counter incremented every time the supervisor restarts a worker after abnormal exit. Reset to 0 at supervisor start. Exposed via the same Prometheus-style metric the SDK exports in production. |
| `lastSuccessfulRefresh()` | Wall-clock timestamp (UTC) of the most recent successful refresh — the last time the SDK confirmed its config source reachable and its held config current. A LIVENESS signal, not an install counter (qfg-41nh.11): advanced by any envelope install AND by a config fetch that completed successfully without installing — a 304 Not Modified, a 200 the reject-older guard dropped as equal-or-older, or a received-and-processed SSE message that was a guard no-op. Transport errors never advance it. Returns null / zero / None before the first successful refresh. |
| `connectionState()` | Returns one of: `initializing`, `connected`, `disconnected`, `falling_back`. Documented values are fixed; SDKs may not invent new strings. |
| `client.close()` | Public shutdown method. Stops the supervisor, joins all workers, releases resources. Idempotent. |

These names are the *contract* — the SDK can map them to idiomatic names
(`LastSuccessfulRefresh()` in Go, `last_successful_refresh` in Python,
`#lastSuccessfulRefresh()` in Java) but the semantics must match.

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

**Reset:** A *successful* worker run (one that delivered at least one
envelope to the cache before exiting) MUST reset the backoff counter to
500ms for the next failure. Add a parallel sub-test for this:

- Worker 1: fails.
- Worker 2 (500ms later): runs successfully, delivers an envelope, then exits
  cleanly after 5s.
- Worker 3 starts: backoff should be **500ms again**, not 1000ms.

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
  for HTTP polling), `reason` (one of: `worker_throw`, `worker_exit`,
  `read_timeout`).
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

## Test 5 — Panic-in-callback recovery (sdk-go specific, optional elsewhere)

**Goal:** A panic / unchecked exception thrown by the user's `OnEnvelope`
callback does NOT tear down the SSE read loop. The supervisor recovers,
logs the panic with stack trace, increments `worker_restart_total` with
`reason="callback_panic"`, and continues processing envelopes.

**Context:** Today's `sdk-go` does NOT recover from a panic inside
`OnEnvelope` — the panic propagates up through `parseStream` and crashes
the worker goroutine. The supervisor *will* restart it (Test 1 catches
that), but the first envelope after a panic-y deploy will repeatedly crash
the goroutine in a tight restart loop. The fix is ~5 lines: a deferred
`recover()` around the `c.cfg.OnEnvelope(&env)` call at
`sdk-go/sse_client.go:226-228` (now line 273 after the read-deadline
refactor). This test ships with that fix in Phase 1 of the hardening plan.

**Setup:**

- Configure the SDK with an `OnEnvelope` callback that panics / throws /
  raises on its first invocation, then succeeds on subsequent invocations.
- Feed the SDK a fake stream that emits two valid envelopes back-to-back.
  (Either via a unit-level fake `parseStream` input, or via an httptest
  server in Go's case.)

**Assert:**

- The first envelope causes the callback to throw. The SDK logs the panic
  (test inspects the logger).
- The SDK does NOT crash the worker — the second envelope is delivered to
  the callback, which succeeds.
- `worker_restart_total` may or may not increment per panic depending on
  whether the SDK treats the panic as a worker restart or as an inline
  recovery — both are acceptable as long as the panic is logged. Document
  which approach the SDK takes in the test comment.
- The user's panic message and stack trace appear in the SDK's log output.

**Per-language hints:**

- **Go:** `defer func() { if r := recover(); r != nil { ... } }()` wrapped
  around the `OnEnvelope` call. The recover must log via the SDK's
  configured logger, not stderr directly. **This is the ~5 line fix
  the bead description references.**
- **Java:** the existing `try/catch (Exception e)` pattern around the user
  callback. sdk-java already catches `Exception` but not `Error` — the
  test should clarify which is intended. Recommendation: catch
  `Throwable` for the SDK's outermost callback wrapper since an
  `OutOfMemoryError` originating in user code shouldn't take down the
  background thread.
- **Python:** `try / except Exception` (NOT bare `except` — let
  `KeyboardInterrupt` and `SystemExit` propagate). Log via
  `logger.exception()` so the traceback is preserved.
- **Ruby:** `rescue StandardError` (NOT `rescue Exception` — same reason
  as Python). Log via `logger.error` with `e.full_message`.
- **Node:** wrap the `await onEnvelope(...)` in `try { } catch (err) { }`.
  Promise rejection from an async callback must be awaited and caught;
  unhandled rejections would crash the process under
  `--unhandled-rejections=strict`.

**Languages where this test is optional:** sdk-java, sdk-python, sdk-ruby,
sdk-node already have language-level idioms (try/catch) and most of those
SDKs already wrap user callbacks. The test is *required* for sdk-go and
*recommended* for all others as a regression guard.

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
t=after first envelope     : connected
t=after worker exit        : disconnected
t=after fallback engages*  : falling_back   (* only if SDK has HTTP fallback)
t=after reconnect succeeds : connected
t=after client.close()     : disconnected
```

Each documented value MUST appear in the transition log at some point if
the SDK supports it. SDKs without HTTP fallback (e.g. a fictional
SSE-only minimal SDK) skip the `falling_back` assertion. **No SDK may
emit a state value not in the documented set.**

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

Each test should be named after its number above, e.g.
`TestSupervisor_RestartsWorkerWithin1000ms` (Go),
`supervisor restarts worker within 1000ms` (Node/jest description).

## Acceptance for this contract

A Tier 1 implementation is accepted when:

1. All six tests run green in the SDK's CI.
2. The SDK exposes `worker_restart_total`, `lastSuccessfulRefresh()`,
   `connectionState()` per the contract.
3. The SDK's `connectionState()` only returns documented values.
4. The PR description in the SDK repo links back to this doc and to the
   parent bead `qfg-47c2`.

## Estimated effort

Per the plan: **1-2 engineer-days per SDK**. The largest variance is
clock injection — SDKs that already have a `Clock` seam (sdk-go via
`time.Now` wrappers, sdk-java via `Clock` parameter) finish faster than
SDKs that need to retrofit one (sdk-ruby, sdk-python).

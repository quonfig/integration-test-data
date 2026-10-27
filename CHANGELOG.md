# Changelog

All notable changes to integration-test-data, one entry per tag. SDKs pin a
tag in CI (see [RELEASING.md](RELEASING.md)); read the entries between your
current pin and the new tag before bumping.

Areas used below:

- **Eval corpus**: YAML cases under `tests/` and JSON fixtures under `data/`.
  These change what every backend SDK must do.
- **Contracts**: the chaos harness (`chaos/`), the supervisor and telemetry
  contract docs, and the boot/injection checks.
- **Generators**: `generators/`, the code that turns the corpus into each SDK's
  tests. A generator-only change alters the emitted test code, not the
  expected behavior.
- **Upgrade notes**: what an SDK or harness has to change when it bumps to the
  tag.

## Unreleased

- README split: change history moved here; README now documents the current
  layout and formats only.

## v2026.10.27.1 - 2026-10-27

### Contracts

- Supervisor contract: new rule and Test 11. A payload the SDK does not
  install (strictly older, generation <= 0, or a node install-throw) never
  pins its ETag (qfg-j7ui, #23). Contract doc only, no corpus change.

## v2026.10.27 - 2026-10-27

### Contracts

- Chaos `08-auth-failure`: the auth-failed holds start at entry via
  `after_ms: 145000` (`within_ms` 240000/255000, holds 90000/105000), with a
  validator test that pins the timing (qfg-goi1.10.38, #22). The scenario is
  not runnable until the WS4 HTTP fault proxy lands.

## v2026.10.26 - 2026-10-26

Generator-only. No YAML changes.

### Generators

- node: INT reads go through `getInt`; malformed stored int/double message
  (qfg-zvyy.4, #19).
- java: `unable_to_coerce_env_var` maps to `QuonfigCoercionException`
  (qfg-koj9, #20).
- ruby: typed `get_or_raise` goes through the typed getter (qfg-zvyy.6, #21).

## v2026.10.23 - 2026-10-23

### Eval corpus

- Typed-getter contract matrix: every getter type read against every stored
  type, look-alike strings, safe int <-> double conversion, malformed
  ints/doubles, a missing ENV_VAR and a decryption failure, each with a
  default, without a default, via `get_or_raise` and via `enabled`. Cases in
  `get.yaml`, `get_or_raise.yaml` and `enabled.yaml`; fixtures
  `getter.contract.*` (qfg-zvyy.1, #18).
- New error key `type_mismatch` for a wrong-type `get_or_raise`.

### Generators

- node: defaulted reads call the typed getter.
- go: generated tests import `sdk-go/v2`.

### Upgrade notes

- sdk-go must be on the `/v2` module path before bumping to this tag.

## v2026.10.22.2 - 2026-10-22

### Contracts

- Supervisor contract: size-caps rule and Test 10 (qfg-6vno.20.1); restart
  counter semantics in Test 5 (qfg-6vno.25) (#17).

## v2026.10.22.1 - 2026-10-22

### Eval corpus

- Regex v1 now rejects `\_`, `\v` and `\x80`-`\xFF` in `tests/regex/dialect.yaml`
  (qfg-ktkr.7, #16).

## v2026.10.22 - 2026-10-22

### Eval corpus

- New `tests/regex/dialect.yaml`: the Quonfig regex v1 writer fixture. 32
  accept rows, 87 reject rows, 15 reason codes with fix-it hints
  (qfg-ktkr.1, #15).
- 17 `PROP_MATCHES` / `PROP_DOES_NOT_MATCH` eval cases in `tests/eval/enabled.yaml`,
  with 5 new flags and segment `code-not-three-digits`.
- `get_or_raise.yaml`: java timing comments updated after sdk-java#47, comment
  only (#14).

## v2026.10.21.1 - 2026-10-21

### Eval corpus

- Init-failure case timing that holds on every platform, Windows included
  (Decision 12, qfg-9p4i.17, #13):
  - refused-leg `fail` cases run one attempt (`init_timeout_ms: 0`);
  - the 401 + 503 case runs one attempt;
  - new 401 + hang case raises `unavailable` at a 9000ms deadline;
  - the upstream-body case runs one attempt.

### Generators

- `api_status` list entries may be verbatim URLs.
- Ruby emits `10_000`-style integer literals.
- Progress lines no longer match CI problem matchers.

## v2026.10.21 - 2026-10-21

### Eval corpus

- Init-failure conformance cases (Decisions 6-9, qfg-9p4i.17, #12): 404/410
  are `unauthorized`; mixed 401/503 legs are `unavailable`;
  `init_timeout_ms: 0` means one attempt; a hang past the per-leg abort is
  `timeout`; the init error redacts URL userinfo and upstream bodies.
- Hung legs moved off port 1 (on the fetch bad-ports list) to `192.0.2.1:8001`
  and `:8002`.

### Generators

- Per-leg `api_status` list, `api_body`, `reason` asserted in every target, and
  `message_excludes` on init cases.

## v2026.10.20 - 2026-10-20

### Eval corpus

- Init-failure corpus in `get_or_raise.yaml`, cases D1-D5: `fail` default,
  refused / hang / 401, `continue`, and the `raise`/`return` aliases. New
  `client_overrides`: `on_init_failure`, `init_timeout_ms`, `api_urls`,
  `api_status` (qfg-9p4i.6, #11).

### Contracts

- Chaos `00-boot-both-down-then-restore` (wait / continue / caught fail) plus
  its setup keys.
- f01/f04 init log contract.

### Upgrade notes

- The Prefab-era overrides `initialization_timeout_sec` and `prefab_api_url`
  are removed. Generators and SDK harnesses that read them must switch to
  `init_timeout_ms` and `api_urls`.

## v2026.10.16.4 - 2026-10-16

### Contracts

- Supervisor first-frame rule: connected means the first valid frame;
  python/ruby get a bounded transparent reconnect. New Test 9, amendments to
  Tests 2 and 6 (qfg-goi1.10.9, #10).
- Scenario 02 drops the forbidden `reconnecting` state.

Includes the v2026.10.16.3 change.

## v2026.10.16.3 - 2026-10-16

### Eval corpus

- `get_or_raise` init-timeout cases point at `http://192.0.2.1:1` (TEST-NET-1)
  instead of `app.staging-prefab.cloud`, so CI never contacts a third-party
  host (qfg-goi1.6, #9).

## v2026.10.16.2 - 2026-10-16

### Contracts

- Chaos expectations take an optional `after_ms` (absolute ms from t=0). The
  validator rejects `after_ms >= within_ms` and
  `after_ms + must_hold_for_ms > within_ms` (qfg-goi1.7, #8).
- chaos README: timeline rules 1-4, Table A/B edits.
- Scenario 05: outage 300s; 05[2] holds 90s starting after 125s.

### Upgrade notes

- Chaos harness loaders must reject unknown expectation keys when bumping to
  this tag.

## v2026.10.16.1 - 2026-10-16

### Eval corpus

- Operator edge cases R1-R6 plus abbreviated semver (Q5): 33 new
  `enabled.yaml` cases in the OPERATOR EDGES block and 10 new flags
  (qfg-goi1.5.1, #7). Includes `IN_INT_RANGE` as `[start, end)` with open
  bounds (R3), SemVer 2.0 prerelease precedence with build metadata ignored
  (R4), a strict timestamp grammar on both sides (R5), and numeric operators
  rejecting numeric-string context values (R6).
- Behavior change: abbreviated versions `"2.0"` and `"2"` now equal `2.0.0`
  (the existing `"2.0"` case flips from false to true). `"v2.0.0"` is still
  invalid.

## v2026.10.16 - 2026-10-16

### Contracts

- Cross-SDK auth-failure rule, supervisor Test 8: auth class is
  401/403/404/410; poll-driven auth-failed entry; one probe per T in
  [150s, 300s]; no latch; one ERROR; state `disconnected` (qfg-goi1.4, #6).
- Chaos `08-auth-failure` fixed (no `reconnecting`). Still gated on the WS4
  HTTP fault proxy.
- Scenario schema: `http_status` alias.

## v2026.10.12 - 2026-10-12

### Eval corpus

Secret-hygiene cases for SDK quality Wave 2 (qfg-goi1.10.11, #5):

- `get_or_raise`: the ENV_VAR int/double coercion error contains the pinned
  template `environment variable "<NAME>" cannot be converted to <type> for
  config "<key>"` and never the env value. New `expected.message_contains` /
  `message_excludes`.
- telemetry: a confidential weighted variant is redacted; a confidential
  ENV_VAR-provided value is redacted (new `selected_value: {redacted: true}`
  matcher); a non-confidential ENV_VAR-provided value reports its resolved
  value.
- `get`: a secret decrypts with a key config whose key comes from a Production
  environment rule.
- New fixtures: `confidential.weighted.variant`,
  `confidential.provided.a.number`, `provided.secret.not.an.int`,
  `provided.secret.not.a.double`, `env.scoped.encryption.key`,
  `env.scoped.secret`.

### Generators

- All six targets handle the new shapes. `NODE_ERRORS.unable_to_coerce_env_var`
  pins the new template.

### CI

- SSDLC PR gate added (#4).

## v2026.10.07 - 2026-10-07

### Eval corpus

- `enabled()` on a missing flag returns `false` (qfg-goi1.3, Decision 7).

## v2026.10.03 - 2026-10-03

### Eval corpus

- Weighted-value cases with a non-ASCII `tracking_id`: SDKs must hash the
  UTF-8 bytes (qfg-1mvb).

## v2026.10.02 - 2026-10-01

### Eval corpus

- New `tests/duration/grammar.yaml`: the shared ISO-8601 duration grammar,
  with cross-language regex traps and magnitude edge cases (qfg-2agi.29).
- Duration grammar-coverage cases in eval; `PT0.5H` became `PT30M` and
  `PT1.5M` was dropped (qfg-2agi.5).
- Malformed and ENV_VAR-provided duration contract cases (qfg-2agi.6, .7).
- Context merge: a named context replaces the whole context; new
  disjoint-attribute tier cases (qfg-2agi.39).
- `enabled_with_contexts`: the partial-override-of-domain case sets `domain`,
  not `key`; new discriminating local-domain-override case (qfg-2agi.28).

### Generators

- Every case category drives the public client, not internals
  (qfg-2agi.30-.34). DURATION cases go through the public getters
  (qfg-2agi.4).
- Raise cases and malformed-duration `Reason=ERROR` assertions now
  discriminate.
- python: DURATION defaults in seconds, exact ms assertion.

## v2026.09.28 - 2026-09-28

### Eval corpus

- Weight-scale contract: `feature-flag.weighted.even-split-ones` (canonical
  1/1 split) and `feature-flag.weighted.non-standard` (sum 180000, normalize by
  total) (qfg-wis6.13).
- Weighted rollout with a missing or empty hash property hashes
  `configKey + ""`; new `zero-first`, `missing-hash` and `no-hash` fixtures
  (qfg-9dxb.8, qfg-t9wo).
- Telemetry: `SPLIT` reason for a weighted value landing in bucket 0
  (qfg-stbb).

### Generators

- `repeat` + `expected.values_seen` for random-per-evaluation cases; `BOOL`
  type alias.
- dotnet: telemetry opt-out in delivery-wire tests.

### Contracts

- Chaos 05 exp[2] tightened to a continuous-freshness hold on
  `lastSuccessfulRefresh` (qfg-e3ja).
- Supervisor contract: Test 7 fork transparency and the Test 6
  diagnostics-must-not-lie rule (qfg-lv4n.4).
- New telemetry transport contract T1-T8 for per-SDK native tests, server-SDK
  byte cap 2MB (qfg-y8je.3, qfg-mol-m3c.1). Ticked for node, ruby, python,
  java, net, go, javascript, react and swift.

## v2026.06.19.1 - 2026-06-19

### Eval corpus

- New `tests/eval/delivery_environment.yaml` (`mode: http_wire`): a
  delivery-wire-shape gate. SDK-key mode against a literal envelope with a
  singular `environment` + `meta.environment` (qfg-xpln). Case 2 encodes the
  decided pin-vs-meta contract (qfg-pinh).

### Contracts

- Chaos failover rig (`scenarios-failover/`, f01-f05) and ordering rig
  (`scenarios-ordering/`, o01-o05) on main (qfg-7h5d.1.2).
- o01 reframed to the parallel-failover hedge happy path (holds the primary's
  41, one install); new o05, slow older primary vs fast newer secondary heals
  forward (qfg-7h5d.1.14.2).
- New `verify-dev-injection/`: token-file -> injection gate for dev overrides
  (qfg-bw7g.1). sdk-java and sdk-net cover it in-repo (qfg-bw7g.6/.7).

### Generators

- Delivery-wire test emitted for all six targets; gofmt- and rubocop-clean.
- go: delivery gate uses `WithSdkKey`, not `WithAPIKey`.

## v2026.06.19 - 2026-06-19

Lightweight tag on a side-branch commit (`fcd4cd2`), not on main's history.
The same change landed on main as `53d949a` and ships in v2026.06.19.1. Pin
v2026.06.19.1 instead.

### Contracts

- Chaos failover rig (f01-f05) and ordering rig (o01-o04), with additive
  scenario-schema vocabulary (`setup.topology`, `setup.upstreams`,
  `http_endpoint: failover`, `proxy: primary|secondary`,
  `primary_*_ms` injects) (qfg-7h5d.1.2).

## v2026.05.28 - 2026-05-28

### Generators

- New dotnet target, mirroring java (qfg-zp7i.3); `Assert.Null` for null
  `expected_data` in post/telemetry (qfg-zp7i.13).
- python: `prefab_api_url` overrides emit `api_urls=[url]` (qfg-l3xp).

## v2026.05.20 - 2026-05-20

### Eval corpus

- New `datadir_value_type` suite: asserts the datadir-loaded raw value type
  before unwrap, catching int/double loader regressions that getter tests
  mask. Emitted for all five backend targets.

### Generators

- java: target outDir corrected to the `core/` submodule.

### Docs

- RELEASING.md: tag-based versioning (#2).

## v2026.05.13 - 2026-05-12

First versioned tag. Before it, SDK CI checked out `main`, so any YAML edit
here landed in every SDK's next run unstaged. This tag captures the corpus as
it stood:

- Eval suites: get, enabled, get_feature_flag, get_or_raise,
  get_weighted_values, context_precedence, enabled_with_contexts, datadir
  environment selection, dev overrides (qfg-pj0.7), IS_PRESENT /
  IS_NOT_PRESENT (qfg-7jnb.1), telemetry post + confidential redaction, and the
  OpenFeature suite.
- Unified TypeScript generator with go, node, python, ruby and java targets.
- Chaos harness with scenarios 1-11 and the Tier 1 supervisor unit-test
  contract (qfg-47c2).
- `verify-sdk-boot/`: per-SDK qfg-login boot check (qfg-is5o).

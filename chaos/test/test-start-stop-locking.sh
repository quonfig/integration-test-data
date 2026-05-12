#!/usr/bin/env bash
#
# Integration test for the chaos harness concurrent-run guard (qfg-47c2.32):
# start-chaos.sh refuses to boot if another live session owns the lock, and
# stop-chaos.sh refuses to tear down a stack it doesn't own (unless --force).
#
# Docker is stubbed via PATH so the test does not require a real docker
# daemon. The stub is permissive — `docker compose ... up -d --wait` exits 0.
#
# Run: ./test/test-start-stop-locking.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAOS_DIR="$(cd "$HERE/.." && pwd)"

TMP_BASE="$(mktemp -d)"
trap 'rm -rf "$TMP_BASE"' EXIT
export QUONFIG_CHAOS_LOCK_DIR="$TMP_BASE/lock"

# --- Build a docker stub that satisfies `docker compose ... up/down --wait` ---
BIN_DIR="$TMP_BASE/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/docker" <<'STUB'
#!/usr/bin/env bash
# permissive docker stub for chaos lock tests — accept any args, exit 0
exit 0
STUB
chmod +x "$BIN_DIR/docker"

# Also stub curl so start-chaos.sh's "wait for toxiproxy admin" loop succeeds
# without a real container. /version is the readiness probe; everything else
# returns success so proxy CRUD is a no-op.
cat > "$BIN_DIR/curl" <<'STUB'
#!/usr/bin/env bash
# permissive curl stub: print empty body, exit 0
exit 0
STUB
chmod +x "$BIN_DIR/curl"

export PATH="$BIN_DIR:$PATH"

pass=0
fail=0
check() {
  local desc="$1"
  local expected_rc="$2"
  local actual_rc="$3"
  if [[ "$expected_rc" == "$actual_rc" ]]; then
    pass=$((pass + 1))
    echo "PASS $desc"
  else
    fail=$((fail + 1))
    echo "FAIL $desc: expected rc=$expected_rc, got rc=$actual_rc"
  fi
}

# Start fresh.
rm -rf "$QUONFIG_CHAOS_LOCK_DIR"

# --- 1. Seed the lock as if a live wrapper owned it (use our own $$). ---
# Source the helper to acquire directly with our pid as a long-lived owner.
# shellcheck source=../chaos-lock.sh
source "$CHAOS_DIR/chaos-lock.sh"
quonfig_chaos_lock_acquire "$QUONFIG_CHAOS_LOCK_DIR" "owner-1" "$$"
check "seed lock owned by our own live pid returns 0" "0" "$?"

# --- 2. A different session calling start-chaos.sh must fail fast. ---
err_out="$TMP_BASE/start.err"
QUONFIG_CHAOS_SESSION="owner-2" \
QUONFIG_CHAOS_OWNER_PID="$$" \
  "$CHAOS_DIR/start-chaos.sh" >/dev/null 2>"$err_out"
rc=$?
check "start-chaos.sh as different session exits non-zero (got 2)" "2" "$rc"
if ! grep -q "already in use" "$err_out"; then
  fail=$((fail + 1))
  echo "FAIL start-chaos.sh stderr should mention 'already in use':"
  sed 's/^/    /' "$err_out"
else
  pass=$((pass + 1))
  echo "PASS start-chaos.sh prints clear 'already in use' error"
fi

# Owner unchanged after a failed attempt.
owner_now="$(quonfig_chaos_lock_owner "$QUONFIG_CHAOS_LOCK_DIR")"
if [[ "$owner_now" == "owner-1" ]]; then
  pass=$((pass + 1))
  echo "PASS lock owner unchanged after rejected start-chaos.sh"
else
  fail=$((fail + 1))
  echo "FAIL lock owner changed: expected=owner-1 actual=$owner_now"
fi

# --- 3. stop-chaos.sh as a different session is a no-op (exit 0, leaves lock). ---
out="$TMP_BASE/stop.err"
QUONFIG_CHAOS_SESSION="owner-2" \
QUONFIG_CHAOS_OWNER_PID="$$" \
  "$CHAOS_DIR/stop-chaos.sh" >/dev/null 2>"$out"
rc=$?
check "stop-chaos.sh as non-owner returns 0 (refuse)" "0" "$rc"
if grep -q "owned by another session" "$out"; then
  pass=$((pass + 1))
  echo "PASS stop-chaos.sh prints 'owned by another session'"
else
  fail=$((fail + 1))
  echo "FAIL stop-chaos.sh missing ownership refusal message"
  sed 's/^/    /' "$out"
fi
owner_now="$(quonfig_chaos_lock_owner "$QUONFIG_CHAOS_LOCK_DIR")"
if [[ "$owner_now" == "owner-1" ]]; then
  pass=$((pass + 1))
  echo "PASS lock still held by owner-1 after rejected stop-chaos.sh"
else
  fail=$((fail + 1))
  echo "FAIL lock was disturbed: owner=$owner_now"
fi

# --- 4. stop-chaos.sh --force tears down regardless and clears lock. ---
QUONFIG_CHAOS_SESSION="owner-2" \
QUONFIG_CHAOS_OWNER_PID="$$" \
  "$CHAOS_DIR/stop-chaos.sh" --force >/dev/null 2>"$out"
rc=$?
check "stop-chaos.sh --force returns 0" "0" "$rc"
if [[ ! -d "$QUONFIG_CHAOS_LOCK_DIR" ]]; then
  pass=$((pass + 1))
  echo "PASS --force cleared the lock"
else
  fail=$((fail + 1))
  echo "FAIL --force left the lock in place"
fi

# --- 5. start-chaos.sh on fresh path acquires; owner recorded; release-on-stop. ---
rm -rf "$QUONFIG_CHAOS_LOCK_DIR"
QUONFIG_CHAOS_SESSION="owner-3" \
QUONFIG_CHAOS_OWNER_PID="$$" \
  "$CHAOS_DIR/start-chaos.sh" >/dev/null 2>"$out"
rc=$?
check "start-chaos.sh on fresh path returns 0" "0" "$rc"
owner_now="$(quonfig_chaos_lock_owner "$QUONFIG_CHAOS_LOCK_DIR")"
if [[ "$owner_now" == "owner-3" ]]; then
  pass=$((pass + 1))
  echo "PASS lock acquired by owner-3"
else
  fail=$((fail + 1))
  echo "FAIL expected owner-3 got=$owner_now"
fi
QUONFIG_CHAOS_SESSION="owner-3" \
QUONFIG_CHAOS_OWNER_PID="$$" \
  "$CHAOS_DIR/stop-chaos.sh" >/dev/null 2>"$out"
rc=$?
check "stop-chaos.sh as owner returns 0 and releases" "0" "$rc"
if [[ ! -d "$QUONFIG_CHAOS_LOCK_DIR" ]]; then
  pass=$((pass + 1))
  echo "PASS lock released after owner stop"
else
  fail=$((fail + 1))
  echo "FAIL lock still present after owner stop"
fi

echo
echo "summary: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi

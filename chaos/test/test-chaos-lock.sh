#!/usr/bin/env bash
#
# Tests for chaos-lock.sh — the file-lock helper that serializes concurrent
# chaos runs (qfg-47c2.32). Pure bash, no docker.
#
# Run: ./test/test-chaos-lock.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [[ ! -f "$ROOT/chaos-lock.sh" ]]; then
  echo "FAIL: $ROOT/chaos-lock.sh does not exist — this test asserts the lock helper" >&2
  exit 1
fi

# shellcheck source=../chaos-lock.sh
source "$ROOT/chaos-lock.sh"

TMP_BASE="$(mktemp -d)"
trap 'rm -rf "$TMP_BASE"' EXIT
LOCK="$TMP_BASE/lock"

pass=0
fail=0

check_eq() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass=$((pass + 1))
    echo "PASS $desc"
  else
    fail=$((fail + 1))
    echo "FAIL $desc: expected=$expected actual=$actual"
  fi
}

# --- 1. Fresh path: acquire succeeds and records owner ---
rm -rf "$LOCK"
quonfig_chaos_lock_acquire "$LOCK" "session-A" "$$"
check_eq "acquire on fresh path returns 0" "0" "$?"
owner_out="$(quonfig_chaos_lock_owner "$LOCK")"
check_eq "owner recorded as session-A" "session-A" "$owner_out"

# --- 2. Held by live owner: second acquire fails fast ---
quonfig_chaos_lock_acquire "$LOCK" "session-B" "$$"
rc=$?
check_eq "second acquire while held by live owner returns 1" "1" "$rc"
owner_out="$(quonfig_chaos_lock_owner "$LOCK")"
check_eq "owner still session-A after failed acquire" "session-A" "$owner_out"

# --- 3. Release by non-owner is a no-op ---
quonfig_chaos_lock_release "$LOCK" "session-B"
rc=$?
check_eq "release by non-owner returns 1" "1" "$rc"
owner_out="$(quonfig_chaos_lock_owner "$LOCK")"
check_eq "lock still held after non-owner release" "session-A" "$owner_out"

# --- 4. Release by owner succeeds; lock then re-acquirable ---
quonfig_chaos_lock_release "$LOCK" "session-A"
rc=$?
check_eq "owner release returns 0" "0" "$rc"
quonfig_chaos_lock_acquire "$LOCK" "session-C" "$$"
rc=$?
check_eq "re-acquire after release returns 0" "0" "$rc"
owner_out="$(quonfig_chaos_lock_owner "$LOCK")"
check_eq "owner now session-C" "session-C" "$owner_out"
quonfig_chaos_lock_release "$LOCK" "session-C"

# --- 5. Stale lock (recorded PID is dead) is broken automatically ---
# Spawn a short-lived child, capture its PID, wait for it to die.
( exit 0 ) &
dead_pid=$!
wait "$dead_pid" 2>/dev/null || true
# Belt-and-suspenders: make sure it's really gone.
if kill -0 "$dead_pid" 2>/dev/null; then
  echo "FAIL setup: pid $dead_pid is unexpectedly still alive" >&2
  exit 1
fi

rm -rf "$LOCK"
quonfig_chaos_lock_acquire "$LOCK" "stale-session" "$dead_pid"
check_eq "seeding stale lock returns 0" "0" "$?"
# Now a fresh acquire by a live process should break the stale lock.
quonfig_chaos_lock_acquire "$LOCK" "fresh-session" "$$"
rc=$?
check_eq "acquire over stale lock returns 0" "0" "$rc"
owner_out="$(quonfig_chaos_lock_owner "$LOCK")"
check_eq "stale lock replaced by fresh owner" "fresh-session" "$owner_out"
quonfig_chaos_lock_release "$LOCK" "fresh-session"

# --- 6. Missing lock: owner returns empty, release is no-op ---
rm -rf "$LOCK"
owner_out="$(quonfig_chaos_lock_owner "$LOCK")"
check_eq "owner on missing lock is empty" "" "$owner_out"
quonfig_chaos_lock_release "$LOCK" "anyone"
check_eq "release on missing lock returns 0" "0" "$?"

# --- summary ---
echo
echo "summary: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi

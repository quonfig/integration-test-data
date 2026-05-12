#!/usr/bin/env bash
#
# chaos-lock.sh — file-lock helper for the shared chaos harness (qfg-47c2.32).
#
# Source this file from start-chaos.sh / stop-chaos.sh / per-SDK run-chaos.sh
# wrappers to coordinate ownership of the docker-compose chaos stack. Without
# coordination, two concurrent SDK chaos runs trample each other: the second
# `start-chaos.sh` recreates proxies under the first run, and either run's
# `stop-chaos.sh` tears down the shared container while the other is mid-test
# (manifesting as `ECONNREFUSED 127.0.0.1:8474` or `clearToxics` failures —
# the cascading-failure symptom this bead exists to fix).
#
# Locking model: `mkdir <lock_dir>` is atomic on all POSIX filesystems and
# works without external dependencies (flock is not a coreutils binary on
# macOS). The lock directory contains a single file `owner` with key=value
# lines recording the session id, pid, hostname, and start time.
#
# A "stale" lock (recorded pid no longer alive on this host) is replaced
# automatically on the next acquire. Hostname is recorded so we never break
# a stale lock that lives on a different machine (NFS / shared volume edge
# case — unlikely here, but cheap to be careful).
#
# Functions:
#   quonfig_chaos_lock_path        — print the canonical lock path
#   quonfig_chaos_lock_acquire DIR SESSION [PID]
#                                  — 0 on acquire, 1 on contention
#   quonfig_chaos_lock_owner DIR   — print the recorded session id (or "")
#   quonfig_chaos_lock_release DIR SESSION
#                                  — 0 on release-by-owner or missing lock,
#                                    1 if held by someone else
#
# Tests: test/test-chaos-lock.sh

# Canonical lock path. Override with QUONFIG_CHAOS_LOCK_DIR for tests.
quonfig_chaos_lock_path() {
  if [[ -n "${QUONFIG_CHAOS_LOCK_DIR:-}" ]]; then
    printf '%s\n' "$QUONFIG_CHAOS_LOCK_DIR"
  else
    printf '%s/quonfig-chaos.lock\n' "${TMPDIR:-/tmp}"
  fi
}

quonfig_chaos_lock_owner() {
  local dir="$1"
  if [[ ! -f "$dir/owner" ]]; then
    return 0
  fi
  awk -F= '$1=="session"{print $2; exit}' "$dir/owner"
}

# Internal: write the owner file for $dir.
_quonfig_chaos_lock_write_owner() {
  local dir="$1"
  local session="$2"
  local pid="$3"
  local host
  host="$(hostname 2>/dev/null || echo unknown)"
  {
    printf 'session=%s\n' "$session"
    printf 'pid=%s\n' "$pid"
    printf 'host=%s\n' "$host"
    printf 'started=%s\n' "$(date +%s)"
  } > "$dir/owner"
}

# Internal: read pid/host from an existing owner file.
_quonfig_chaos_lock_read_field() {
  local dir="$1"
  local field="$2"
  if [[ ! -f "$dir/owner" ]]; then
    return 0
  fi
  awk -F= -v f="$field" '$1==f{print $2; exit}' "$dir/owner"
}

# Internal: is the recorded owner still alive on this host?
_quonfig_chaos_lock_owner_alive() {
  local dir="$1"
  local pid host self_host
  pid="$(_quonfig_chaos_lock_read_field "$dir" pid)"
  host="$(_quonfig_chaos_lock_read_field "$dir" host)"
  self_host="$(hostname 2>/dev/null || echo unknown)"
  # Cross-host locks: we conservatively treat as alive (do not break).
  if [[ -n "$host" && "$host" != "$self_host" ]]; then
    return 0
  fi
  if [[ -z "$pid" ]]; then
    return 1
  fi
  kill -0 "$pid" 2>/dev/null
}

quonfig_chaos_lock_acquire() {
  local dir="$1"
  local session="$2"
  local pid="${3:-$$}"
  if [[ -z "$dir" || -z "$session" ]]; then
    echo "quonfig_chaos_lock_acquire: dir and session are required" >&2
    return 2
  fi
  # Fast path: atomic mkdir.
  if mkdir "$dir" 2>/dev/null; then
    _quonfig_chaos_lock_write_owner "$dir" "$session" "$pid"
    return 0
  fi
  # Held: see if the owner is still alive.
  if _quonfig_chaos_lock_owner_alive "$dir"; then
    return 1
  fi
  # Stale: replace.
  rm -rf "$dir"
  if mkdir "$dir" 2>/dev/null; then
    _quonfig_chaos_lock_write_owner "$dir" "$session" "$pid"
    return 0
  fi
  # Lost the race to another acquirer; treat as contention.
  return 1
}

quonfig_chaos_lock_release() {
  local dir="$1"
  local session="$2"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi
  local current
  current="$(quonfig_chaos_lock_owner "$dir")"
  if [[ -z "$current" ]]; then
    # Owner file is missing — treat as ours and clean up.
    rm -rf "$dir"
    return 0
  fi
  if [[ "$current" != "$session" ]]; then
    return 1
  fi
  rm -rf "$dir"
  return 0
}

#!/usr/bin/env bash
#
# Tear down the chaos harness. Ownership-checked (qfg-47c2.32): if the running
# stack is owned by a different session (another SDK's chaos run), refuse to
# tear it down. Pass --force to override.
#
# Usage:
#   ./stop-chaos.sh           # only tear down if we own the lock
#   ./stop-chaos.sh --force   # tear down regardless; reset the lock

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# shellcheck source=./chaos-lock.sh
source "$HERE/chaos-lock.sh"

FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force) FORCE=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

DOCKER_BIN="${DOCKER_BIN:-docker}"

QUONFIG_CHAOS_SESSION="${QUONFIG_CHAOS_SESSION:-pid-$$}"
CHAOS_LOCK_DIR="$(quonfig_chaos_lock_path)"
CURRENT_OWNER="$(quonfig_chaos_lock_owner "$CHAOS_LOCK_DIR" || true)"

if [[ "$FORCE" == "0" && -n "$CURRENT_OWNER" && "$CURRENT_OWNER" != "$QUONFIG_CHAOS_SESSION" ]]; then
  echo "==> chaos harness is owned by another session ($CURRENT_OWNER) — leaving it running" >&2
  echo "==> our session: $QUONFIG_CHAOS_SESSION" >&2
  echo "==> pass --force to tear down anyway (will interrupt the other run)" >&2
  exit 0
fi

# `down` with all profiles removes the api-delivery container(s) too if they were
# started via --with-upstream / --failover / --ordering. Safe either way.
"$DOCKER_BIN" compose --profile upstream --profile ordering down --remove-orphans

if [[ "$FORCE" == "1" ]]; then
  # Force-clear the lock regardless of owner.
  rm -rf "$CHAOS_LOCK_DIR"
else
  quonfig_chaos_lock_release "$CHAOS_LOCK_DIR" "$QUONFIG_CHAOS_SESSION" || true
fi

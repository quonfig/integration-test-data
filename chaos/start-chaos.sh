#!/usr/bin/env bash
#
# Shared chaos-harness launcher.
#
# Boots toxiproxy via docker-compose, waits for its admin API to come up,
# then (re)creates the named SSE / HTTP / secondary proxies pointing at the
# upstream api-delivery. Every SDK's CI invokes this same script — there is
# exactly one boot path, regardless of language. See ./README.md.
#
# Three rigs share this launcher:
#   single   — sse + http proxies → one upstream (the original suite).
#   failover — sse + http (primary) + secondary proxies, all → ONE upstream.
#              The SDK targets [http, secondary]; toxics hit the primary leg.
#   ordering — http (primary) + secondary proxies → TWO upstreams pinned to
#              divergent Meta.generations (FIXTURE_GENERATION). The SDK targets
#              both and must end up holding the higher generation.
#
# Usage:
#   ./start-chaos.sh                                  # boot toxiproxy only
#   ./start-chaos.sh --with-upstream                  # also boot api-delivery
#   ./start-chaos.sh --failover                       # 1 upstream, primary+secondary proxies
#   ./start-chaos.sh --ordering --primary-gen 41 --secondary-gen 42
#   ./start-chaos.sh --upstream-host my-host --upstream-port 6550
#
# Env (override-able):
#   TOXIPROXY_ADMIN_PORT          admin port (default 8474)
#   SSE_PROXY_PORT                host SSE port (default 18550)
#   HTTP_PROXY_PORT               host HTTP (primary) port (default 18551)
#   SECONDARY_PROXY_PORT          host HTTP secondary-leg port (default 18552)
#   CHAOS_UPSTREAM_HOST           where toxiproxy forwards to (default host.docker.internal)
#   CHAOS_UPSTREAM_SSE            upstream SSE port (default 6550)
#   CHAOS_UPSTREAM_HTTP           upstream HTTP port (default 6550)
#   CHAOS_SECONDARY_UPSTREAM_HOST secondary-leg upstream host (default = CHAOS_UPSTREAM_HOST)
#   CHAOS_SECONDARY_UPSTREAM_HTTP secondary-leg upstream port (default = CHAOS_UPSTREAM_HTTP)
#   PRIMARY_GENERATION            FIXTURE_GENERATION for the primary upstream (default 0)
#   SECONDARY_GENERATION          FIXTURE_GENERATION for the secondary upstream (default 0)
#
# Idempotent: safe to run repeatedly. Tears existing proxies down before recreating.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# shellcheck source=./chaos-lock.sh
source "$HERE/chaos-lock.sh"

# Concurrent-run guard (qfg-47c2.32). The chaos docker-compose stack is a
# host-wide singleton — two SDK chaos suites trying to share it produce the
# cascading ECONNREFUSED / clearToxics failures this lock exists to prevent.
# Callers that want serial reuse should export QUONFIG_CHAOS_SESSION (run-chaos.sh
# wrappers do this).
QUONFIG_CHAOS_SESSION="${QUONFIG_CHAOS_SESSION:-pid-$$}"
# The owner PID drives stale-lock detection (kill -0). When invoked from a
# per-SDK run-chaos.sh wrapper, the wrapper exports its own PID here so the
# lock outlives this short-lived start script.
QUONFIG_CHAOS_OWNER_PID="${QUONFIG_CHAOS_OWNER_PID:-$$}"
export QUONFIG_CHAOS_SESSION QUONFIG_CHAOS_OWNER_PID
CHAOS_LOCK_DIR="$(quonfig_chaos_lock_path)"
if ! quonfig_chaos_lock_acquire "$CHAOS_LOCK_DIR" "$QUONFIG_CHAOS_SESSION" "$QUONFIG_CHAOS_OWNER_PID"; then
  echo "==> chaos harness is already in use by another session:" >&2
  if [[ -f "$CHAOS_LOCK_DIR/owner" ]]; then
    sed 's/^/      /' "$CHAOS_LOCK_DIR/owner" >&2
  fi
  echo "==> wait for it to finish, or run \`./stop-chaos.sh --force\` if you believe it is stale." >&2
  exit 2
fi

TOXIPROXY_ADMIN_PORT="${TOXIPROXY_ADMIN_PORT:-8474}"
SSE_PROXY_PORT="${SSE_PROXY_PORT:-18550}"
HTTP_PROXY_PORT="${HTTP_PROXY_PORT:-18551}"
SECONDARY_PROXY_PORT="${SECONDARY_PROXY_PORT:-18552}"
CHAOS_UPSTREAM_HOST="${CHAOS_UPSTREAM_HOST:-host.docker.internal}"
CHAOS_UPSTREAM_SSE="${CHAOS_UPSTREAM_SSE:-6550}"
CHAOS_UPSTREAM_HTTP="${CHAOS_UPSTREAM_HTTP:-6550}"
# Secondary-leg upstream. Empty here; resolved to the primary upstream after arg
# parsing unless --ordering / the env vars point it at a distinct upstream.
CHAOS_SECONDARY_UPSTREAM_HOST="${CHAOS_SECONDARY_UPSTREAM_HOST:-}"
CHAOS_SECONDARY_UPSTREAM_HTTP="${CHAOS_SECONDARY_UPSTREAM_HTTP:-}"
PRIMARY_GENERATION="${PRIMARY_GENERATION:-0}"
SECONDARY_GENERATION="${SECONDARY_GENERATION:-0}"

PROFILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-upstream)
      PROFILES+=("--profile" "upstream")
      # Inside the compose network, the upstream is reachable as 'api-delivery:8080'.
      # Override the host/port to point there rather than out-of-network.
      CHAOS_UPSTREAM_HOST="api-delivery"
      CHAOS_UPSTREAM_SSE="8080"
      CHAOS_UPSTREAM_HTTP="8080"
      shift
      ;;
    --failover)
      # Failover rig: one fixture upstream behind the primary (http) + secondary
      # proxies. The secondary proxy points at the SAME upstream as the primary.
      PROFILES+=("--profile" "upstream")
      CHAOS_UPSTREAM_HOST="api-delivery"
      CHAOS_UPSTREAM_SSE="8080"
      CHAOS_UPSTREAM_HTTP="8080"
      shift
      ;;
    --ordering)
      # Ordering rig: TWO fixture upstreams at divergent generations. The primary
      # (http) proxy → api-delivery; the secondary proxy → api-delivery-secondary.
      PROFILES+=("--profile" "upstream" "--profile" "ordering")
      CHAOS_UPSTREAM_HOST="api-delivery"
      CHAOS_UPSTREAM_SSE="8080"
      CHAOS_UPSTREAM_HTTP="8080"
      CHAOS_SECONDARY_UPSTREAM_HOST="api-delivery-secondary"
      CHAOS_SECONDARY_UPSTREAM_HTTP="8080"
      shift
      ;;
    --primary-gen)
      PRIMARY_GENERATION="$2"
      shift 2
      ;;
    --secondary-gen)
      SECONDARY_GENERATION="$2"
      shift 2
      ;;
    --upstream-host)
      CHAOS_UPSTREAM_HOST="$2"
      shift 2
      ;;
    --upstream-port)
      CHAOS_UPSTREAM_SSE="$2"
      CHAOS_UPSTREAM_HTTP="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,42p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Default the secondary leg to the primary upstream unless an --ordering / env
# override pointed it at a distinct one.
CHAOS_SECONDARY_UPSTREAM_HOST="${CHAOS_SECONDARY_UPSTREAM_HOST:-$CHAOS_UPSTREAM_HOST}"
CHAOS_SECONDARY_UPSTREAM_HTTP="${CHAOS_SECONDARY_UPSTREAM_HTTP:-$CHAOS_UPSTREAM_HTTP}"

export TOXIPROXY_ADMIN_PORT SSE_PROXY_PORT HTTP_PROXY_PORT SECONDARY_PROXY_PORT
export CHAOS_UPSTREAM_HOST CHAOS_UPSTREAM_SSE CHAOS_UPSTREAM_HTTP
export CHAOS_SECONDARY_UPSTREAM_HOST CHAOS_SECONDARY_UPSTREAM_HTTP
export PRIMARY_GENERATION SECONDARY_GENERATION

DOCKER_BIN="${DOCKER_BIN:-docker}"

echo "==> booting toxiproxy ${PROFILES[*]+${PROFILES[*]}}"
"$DOCKER_BIN" compose ${PROFILES[@]+"${PROFILES[@]}"} up -d --wait

# Wait for the admin API, in case --wait returned before the health-check stabilized.
echo "==> waiting for toxiproxy admin api on :$TOXIPROXY_ADMIN_PORT"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$TOXIPROXY_ADMIN_PORT/version" > /dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    echo "toxiproxy admin api did not come up within 60s" >&2
    exit 1
  fi
done

# Tear down any existing proxies with our names so we are idempotent.
for name in sse http secondary; do
  curl -fsS -X DELETE "http://127.0.0.1:$TOXIPROXY_ADMIN_PORT/proxies/$name" > /dev/null 2>&1 || true
done

create_proxy() {
  local name="$1"
  local listen_port="$2"
  local upstream_host="$3"
  local upstream_port="$4"
  echo "==> creating proxy $name: 0.0.0.0:$listen_port -> $upstream_host:$upstream_port"
  curl -fsS -X POST "http://127.0.0.1:$TOXIPROXY_ADMIN_PORT/proxies" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"listen\":\"0.0.0.0:$listen_port\",\"upstream\":\"$upstream_host:$upstream_port\",\"enabled\":true}" \
    > /dev/null
}

# Inside the toxiproxy container, listen-port = container-side port.
# Compose publishes those container ports to host as SSE_PROXY_PORT /
# HTTP_PROXY_PORT / SECONDARY_PROXY_PORT.
create_proxy sse 18550 "$CHAOS_UPSTREAM_HOST" "$CHAOS_UPSTREAM_SSE"
create_proxy http 18551 "$CHAOS_UPSTREAM_HOST" "$CHAOS_UPSTREAM_HTTP"
# The secondary HTTP leg. For the single/failover rigs it points at the same
# upstream as the primary; for the ordering rig it points at api-delivery-secondary.
create_proxy secondary 18552 "$CHAOS_SECONDARY_UPSTREAM_HOST" "$CHAOS_SECONDARY_UPSTREAM_HTTP"

cat <<EOF

chaos harness is up.

  toxiproxy admin     http://127.0.0.1:$TOXIPROXY_ADMIN_PORT
  SSE  (chaos)        http://127.0.0.1:$SSE_PROXY_PORT   -> $CHAOS_UPSTREAM_HOST:$CHAOS_UPSTREAM_SSE
  HTTP (chaos,primary)http://127.0.0.1:$HTTP_PROXY_PORT  -> $CHAOS_UPSTREAM_HOST:$CHAOS_UPSTREAM_HTTP
  HTTP (chaos,second.)http://127.0.0.1:$SECONDARY_PROXY_PORT  -> $CHAOS_SECONDARY_UPSTREAM_HOST:$CHAOS_SECONDARY_UPSTREAM_HTTP

Point SDK clients at the chaos ports; inject toxics via the toxiproxy admin api.
For the failover rig the SDK targets [HTTP primary, HTTP secondary]; toxics hit
the primary (http) leg. For the ordering rig the two legs serve generations
$PRIMARY_GENERATION (primary) and $SECONDARY_GENERATION (secondary).
Tear down with ./stop-chaos.sh.
EOF

#!/usr/bin/env bash
# verify-dev-injection: assert backend SDKs auto-inject quonfig-user.email
# from ~/.quonfig/tokens.json into the evaluation context BY DEFAULT — with
# NO opt-in (no enableQuonfigUserContext / WithQuonfigUserContext, no
# QUONFIG_DEV_CONTEXT=true). This is the front-half coverage the corpus
# lacks: dev_overrides.yaml only tests the evaluator (it hands the context
# in directly); nothing else proves an SDK turns a token file into a
# quonfig-user.email context on its own. See bead qfg-bw7g.1.
#
# Contract, per SDK, two phases:
#   - token-present: write a fake ~/.quonfig/tokens.json with userEmail
#       bob@foo.com, construct a DEFAULT-config datadir client, evaluate
#       the bool flag feature-flag.dev-override -> expect TRUE (the
#       injected quonfig-user.email=bob@foo.com matches the flag's rule).
#   - no-token: same client, but no token file at all -> expect FALSE
#       (the flag's ALWAYS_TRUE fallback rule yields false).
#
# The flag fixture lives at
#   data/integration-tests/feature-flags/feature-flag.dev-override.json
# and is shared with the eval-only dev_overrides.yaml corpus (untouched).
#
# Against an SDK whose dev-context default is still OPT-IN, the token-present
# phase returns FALSE -> the check FAILS (this is the intended RED). Flipping
# the SDK default to on turns it GREEN. The no-token phase passes either way.
#
# Scope: sdk-node, sdk-go, sdk-ruby, sdk-python (the loader-bearing backend
# SDKs). sdk-java / sdk-net join once their loaders land (qfg-bw7g.6/.7).
# Browser SDKs are excluded — no filesystem.
#
# Usage:
#   ./run.sh                 # all in-scope SDKs
#   ./run.sh sdk-node        # just one (used by per-SDK beads)

set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DATADIR="$ROOT_DIR/integration-test-data/data/integration-tests"
INJECT_KEY="feature-flag.dev-override"
INJECT_EMAIL="bob@foo.com"

if [ ! -f "$DATADIR/quonfig.json" ]; then
  echo "missing datadir: $DATADIR/quonfig.json" >&2
  exit 2
fi
if [ ! -f "$DATADIR/feature-flags/${INJECT_KEY}.json" ]; then
  echo "missing flag fixture: $DATADIR/feature-flags/${INJECT_KEY}.json" >&2
  exit 2
fi

ONLY="${1:-}"

# A SECOND fixture home with NO tokens.json, for the no-token phase.
NOTOKEN_HOME="$(mktemp -d -t quonfig-inject-notoken.XXXXXX)"
TOKEN_HOME="$(mktemp -d -t quonfig-inject-token.XXXXXX)"
trap 'rm -rf "$NOTOKEN_HOME" "$TOKEN_HOME"' EXIT
mkdir -p "$TOKEN_HOME/.quonfig"
mkdir -p "$NOTOKEN_HOME/.quonfig"   # dir exists, file does not
cat > "$TOKEN_HOME/.quonfig/tokens.json" <<JSON
{
  "userEmail": "$INJECT_EMAIL",
  "accessToken": "synthetic-token-for-inject-check",
  "domain": "quonfig.com"
}
JSON

# Rely on the DEFAULT. The whole point is no opt-in: leave
# QUONFIG_DEV_CONTEXT unset and never pass the enable option.
unset QUONFIG_DEV_CONTEXT
unset QUONFIG_BACKEND_SDK_KEY
unset QUONFIG_SDK_KEY
unset QUONFIG_DOMAIN

export QFG_INJECT_DATADIR="$DATADIR"
export QFG_INJECT_KEY="$INJECT_KEY"

PASS_COUNT=0
FAIL_COUNT=0
FAILED=()

# args: <sdk-name> <runner-cmd...>
# runs the runner twice, once per phase, via the QFG_INJECT_* env contract.
run_sdk() {
  local name="$1"; shift
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then
    return
  fi
  echo
  echo "=== $name ==="
  local ok=1
  # token-present -> expect true
  if QFG_INJECT_FIXTURE_HOME="$TOKEN_HOME" QFG_INJECT_EXPECTED="true" "$@"; then
    :
  else
    ok=0
  fi
  # no-token -> expect false
  if QFG_INJECT_FIXTURE_HOME="$NOTOKEN_HOME" QFG_INJECT_EXPECTED="false" "$@"; then
    :
  else
    ok=0
  fi
  if [ "$ok" -eq 1 ]; then
    PASS_COUNT=$((PASS_COUNT+1))
  else
    FAIL_COUNT=$((FAIL_COUNT+1))
    FAILED+=("$name")
  fi
}

run_sdk sdk-python bash -c "cd '$ROOT_DIR/sdk-python' && poetry run python '$SCRIPT_DIR/inject_check.py'"
run_sdk sdk-node   bash -c "node '$SCRIPT_DIR/inject_check.mjs'"
run_sdk sdk-ruby   bash -c "ruby '$SCRIPT_DIR/inject_check.rb'"
# GOWORK=off so boot_check_go's local replace directive resolves (same as
# verify-sdk-boot — this module isn't listed in the monorepo go.work).
run_sdk sdk-go     bash -c "cd '$SCRIPT_DIR/inject_check_go' && GOWORK=off go run ."

echo
echo "================================"
echo "verify-dev-injection: $PASS_COUNT passed, $FAIL_COUNT failed"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Failed SDKs: ${FAILED[*]}"
  exit 1
fi

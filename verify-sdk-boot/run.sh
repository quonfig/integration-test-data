#!/usr/bin/env bash
# verify-sdk-boot: assert backend SDKs boot without QUONFIG_BACKEND_SDK_KEY,
# relying on ~/.quonfig/tokens.json (the `qfg login` flow) plus a local
# datadir workspace. Scope: sdk-node, sdk-go, sdk-ruby, sdk-python. The
# browser SDK (sdk-javascript) is excluded — no filesystem. See bead
# qfg-is5o for context.
#
# Setup per SDK:
#   - QUONFIG_BACKEND_SDK_KEY (and Python's legacy QUONFIG_SDK_KEY) unset.
#   - A synthetic tokens.json fixture in a tmpdir.
#   - QUONFIG_CONFIG_HOME points at the fixture (honored by sdk-python).
#   - QFG_BOOT_CHECK_FIXTURE_HOME passed to each script; the script sets
#     HOME in-process before importing the SDK, so the SDK's home-dir
#     lookup (os.homedir / Dir.home / os.UserHomeDir / Path.home) finds
#     the fixture without disturbing the outer shell's HOME (Go's build
#     cache, npm/poetry config, etc.).
#   - Datadir = integration-test-data/data/integration-tests so the SDK
#     has something real to evaluate against without an api-delivery
#     server (sdk-node and sdk-ruby both refuse to construct in network
#     mode without an SDK key, so datadir mode is the realistic local-dev
#     analogue of `qfg login`).
#
# Each per-SDK script asserts: client constructs without error AND a
# smoke get() returns the expected value AND (where the loader is
# reachable from outside the SDK package) quonfig-user.email is wired in.

set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DATADIR="$ROOT_DIR/integration-test-data/data/integration-tests"

if [ ! -f "$DATADIR/quonfig.json" ]; then
  echo "missing datadir: $DATADIR/quonfig.json" >&2
  exit 2
fi

FIXTURE_HOME="$(mktemp -d -t quonfig-boot-check.XXXXXX)"
trap 'rm -rf "$FIXTURE_HOME"' EXIT
mkdir -p "$FIXTURE_HOME/.quonfig"
cat > "$FIXTURE_HOME/.quonfig/tokens.json" <<'JSON'
{
  "userEmail": "boot-check@quonfig.local",
  "accessToken": "synthetic-token-for-boot-check",
  "domain": "quonfig.com"
}
JSON

export QFG_BOOT_CHECK_FIXTURE_HOME="$FIXTURE_HOME"
export QFG_BOOT_CHECK_DATADIR="$DATADIR"
export QFG_BOOT_CHECK_EXPECTED_EMAIL="boot-check@quonfig.local"
export QFG_BOOT_CHECK_EXPECTED_KEY="brand.new.string"
export QFG_BOOT_CHECK_EXPECTED_VALUE="hello.world"

export QUONFIG_CONFIG_HOME="$FIXTURE_HOME"
export QUONFIG_DEV_CONTEXT="true"
unset QUONFIG_BACKEND_SDK_KEY
unset QUONFIG_SDK_KEY
unset QUONFIG_DOMAIN

PASS_COUNT=0
FAIL_COUNT=0
FAILED_SDKS=()

run_check() {
  local name="$1"
  shift
  echo
  echo "=== $name ==="
  if "$@"; then
    PASS_COUNT=$((PASS_COUNT+1))
  else
    FAIL_COUNT=$((FAIL_COUNT+1))
    FAILED_SDKS+=("$name")
  fi
}

run_check sdk-python bash -c "cd '$ROOT_DIR/sdk-python' && poetry run python '$SCRIPT_DIR/boot_check.py'"
run_check sdk-node   bash -c "node '$SCRIPT_DIR/boot_check.mjs'"
run_check sdk-ruby   bash -c "ruby '$SCRIPT_DIR/boot_check.rb'"
# GOWORK=off so the local replace directive in boot_check_go/go.mod takes
# over — without it, the monorepo's go.work refuses commands run from a
# module not listed in `use ( ... )`.
run_check sdk-go     bash -c "cd '$SCRIPT_DIR/boot_check_go' && GOWORK=off go run ."

echo
echo "================================"
echo "verify-sdk-boot: $PASS_COUNT passed, $FAIL_COUNT failed"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Failed SDKs: ${FAILED_SDKS[*]}"
  exit 1
fi

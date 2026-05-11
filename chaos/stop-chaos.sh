#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

DOCKER_BIN="${DOCKER_BIN:-docker}"

# `down` with all profiles removes the api-delivery container too if it was started
# via --with-upstream. Safe either way.
"$DOCKER_BIN" compose --profile upstream down --remove-orphans

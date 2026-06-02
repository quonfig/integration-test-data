"""Injection-check for sdk-python. See run.sh for context.

Boots a DEFAULT-config datadir client (NO enable_quonfig_user_context, NO
QUONFIG_DEV_CONTEXT) and asserts the dev-override flag resolves purely from
token-file injection.
"""

from __future__ import annotations

import os
import sys


def fail(msg: str) -> "None":
    print(f"FAIL sdk-python: {msg}", file=sys.stderr)
    sys.exit(1)


fixture = os.environ.get("QFG_INJECT_FIXTURE_HOME")
if not fixture:
    fail("QFG_INJECT_FIXTURE_HOME unset")

# sdk-python's loader honors QUONFIG_CONFIG_HOME (and HOME as a fallback);
# point both at the fixture so the synthetic tokens.json is discovered (or,
# in the no-token phase, not found).
os.environ["HOME"] = fixture
os.environ["QUONFIG_CONFIG_HOME"] = fixture
# The default must hold without the env opt-in.
os.environ.pop("QUONFIG_DEV_CONTEXT", None)

datadir = os.environ.get("QFG_INJECT_DATADIR")
key = os.environ.get("QFG_INJECT_KEY")
expected = os.environ.get("QFG_INJECT_EXPECTED") == "true"
if not (datadir and key):
    fail("missing QFG_INJECT_* env vars")

try:
    from quonfig import Quonfig
except Exception as e:  # noqa: BLE001
    fail(f"import quonfig failed: {type(e).__name__}: {e}")

try:
    # DEFAULT config — deliberately NO enable_quonfig_user_context.
    client = Quonfig(
        datadir=datadir,
        environment="Production",
        collect_evaluation_summaries=False,
        context_upload_mode="none",
    ).init()
except Exception as e:  # noqa: BLE001
    fail(f"Quonfig() construct/init raised: {type(e).__name__}: {e}")

try:
    value = client.get_bool(key, default=False)
except Exception as e:  # noqa: BLE001
    fail(f"get_bool raised: {type(e).__name__}: {e}")

if value != expected:
    phase = "token-present" if expected else "no-token"
    fail(f"get_bool({key!r}) = {value!r}, expected {expected} (phase: {phase}, HOME={fixture})")

phase = "token-present" if expected else "no-token"
print(f"OK sdk-python: {phase} -> get_bool({key!r})={value}")

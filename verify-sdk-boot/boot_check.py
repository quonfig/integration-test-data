"""Boot-check for sdk-python. See ../verify-sdk-boot/run.sh for context."""

from __future__ import annotations

import os
import sys


def fail(msg: str) -> "None":
    print(f"FAIL sdk-python: {msg}", file=sys.stderr)
    sys.exit(1)


fixture = os.environ.get("QFG_BOOT_CHECK_FIXTURE_HOME")
if not fixture:
    fail("QFG_BOOT_CHECK_FIXTURE_HOME unset")

# Point HOME at the fixture in-process so any HOME-based lookup also hits
# the synthetic tokens.json; sdk-python's loader already honors
# QUONFIG_CONFIG_HOME (set by run.sh) but mirroring keeps the four SDK
# scripts symmetric.
os.environ["HOME"] = fixture

for key in ("QUONFIG_BACKEND_SDK_KEY", "QUONFIG_SDK_KEY"):
    if os.environ.get(key):
        fail(f"{key} must be unset — boot-check exists to prove the SDK boots without it")

datadir = os.environ.get("QFG_BOOT_CHECK_DATADIR")
expected_email = os.environ.get("QFG_BOOT_CHECK_EXPECTED_EMAIL")
expected_key = os.environ.get("QFG_BOOT_CHECK_EXPECTED_KEY")
expected_value = os.environ.get("QFG_BOOT_CHECK_EXPECTED_VALUE")
if not (datadir and expected_email and expected_key and expected_value):
    fail("missing QFG_BOOT_CHECK_* env vars")

try:
    from quonfig import Quonfig
    from quonfig.dev_context import load_quonfig_user_context
except Exception as e:  # noqa: BLE001
    fail(f"import quonfig failed: {type(e).__name__}: {e}")

dev_ctx = load_quonfig_user_context()
if dev_ctx is None:
    fail("dev_context loader returned None — synthetic tokens.json not picked up")
actual_email = (dev_ctx or {}).get("quonfig-user", {}).get("email")
if actual_email != expected_email:
    fail(
        f"loader returned quonfig-user.email={actual_email!r}, expected {expected_email!r}"
    )

try:
    client = Quonfig(
        datadir=datadir,
        environment="Production",
        enable_quonfig_user_context=True,
        collect_evaluation_summaries=False,
        context_upload_mode="none",
    ).init()
except Exception as e:  # noqa: BLE001
    fail(f"Quonfig() raised without QUONFIG_BACKEND_SDK_KEY: {type(e).__name__}: {e}")

try:
    value = client.get_string(expected_key, default="__BOOT_CHECK_DEFAULT__")
except Exception as e:  # noqa: BLE001
    fail(f"get_string raised: {type(e).__name__}: {e}")

if value != expected_value:
    fail(f"get_string({expected_key!r}) returned {value!r}, expected {expected_value!r}")

print(
    f"OK sdk-python: constructed without sdk_key, dev_context email={expected_email}, "
    f"get_string({expected_key!r})={expected_value!r}"
)

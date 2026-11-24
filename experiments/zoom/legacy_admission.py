"""One-time migration for this experiment's old OpenRouter budget rejection.

The historical transport must have reserved every dispatch in charges.json
before network I/O and must never have removed reservation entries.
"""

import fcntl
import hashlib
import json
from pathlib import Path

try:
    from .session import certify_admission_deferred
except ImportError:  # Direct harness imports with experiments/zoom on sys.path.
    from session import certify_admission_deferred


LEGACY_BUDGET_FAILURE = {
    "type": "KnownProviderFailure",
    "detail": "Недостаточен остаток лимита, отправки не было",
}


def certify_unsubmitted_budget(session_dir, attempt_index, *, ledger_path, ledger_key):
    ledger_path = Path(ledger_path).resolve()

    def verify(directory, request, failure):
        if failure != LEGACY_BUDGET_FAILURE:
            raise ValueError("Only the exact legacy pre-send budget refusal can be migrated")
        if (directory / "error.json").exists():
            raise ValueError("Transport has response evidence")
        if str(directory.relative_to(ledger_path.parent)) != ledger_key:
            raise ValueError("Ledger key does not identify this exact attempt")
        with (ledger_path.parent / "charges.lock").open("a+b") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            ledger_bytes = ledger_path.read_bytes()
            ledger = json.loads(ledger_bytes)
            if not isinstance(ledger, dict) or ledger_key in ledger:
                raise ValueError("Ledger has a reservation or does not establish non-dispatch")
            return {
                "kind": "legacy_pre_send_budget_deferral", "externally_sent": False,
                "ledger_path": str(ledger_path), "ledger_key": ledger_key,
                "ledger_sha256": hashlib.sha256(ledger_bytes).hexdigest(),
                "ledger_snapshot": ledger, "reservation_absent": True,
            }

    return certify_admission_deferred(session_dir, attempt_index, verify_transport=verify)

"""Offline fixture. Announce readiness only after the owned child exists."""

import signal
import subprocess
import sys
import time

worker = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"])


def finish(_signal, _frame):
    # The group signal also reaches the child. Reap it before the leader exits.
    worker.wait(timeout=2)
    sys.exit(0)


signal.signal(signal.SIGTERM, finish)
while True:
    print("fixture-ready: 1 OK", flush=True)
    print("heartbeat", flush=True)
    time.sleep(0.025)

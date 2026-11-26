"""Offline fixture. Announce readiness only after the owned child exists."""

import signal
import subprocess
import sys
import time

stopping = False


def finish(_signal, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, finish)
worker = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"])
try:
    while not stopping:
        print("fixture-ready: 1 OK", flush=True)
        print("heartbeat", flush=True)
        time.sleep(0.025)
except BrokenPipeError:
    # The external observer disappeared; the fixture still owns this direct child.
    pass
finally:
    worker.terminate()
    worker.wait()

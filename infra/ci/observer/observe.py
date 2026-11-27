"""Opt-in POSIX observer for the existing, offline Contracts check."""

import argparse
import hashlib
import json
import os
import platform
import re
import selectors
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

from report import Attempt, open_report, previous_result

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CONTRACTS = ROOT / "contracts"
SYNTHETIC_POLICY = dict(mode="synthetic-stop", attempt_ms=6000, stage_ms=5000, silence_ms=400)
POLL_SECONDS = 0.025
EXECUTOR_ENV = {"PATH": os.defpath}


class GroupLines:
    """Consume bounded chunks. A partial, oversized or unknown line proves nothing."""
    def __init__(self, expected):
        self.expected = expected
        self.tail = b""
        self.oversized = False

    def feed(self, data):
        parts = data.split(b"\n")
        for index, part in enumerate(parts):
            if len(self.tail) + len(part) > 128:
                self.oversized = True
            if not self.oversized:
                self.tail += part
            if index == len(parts) - 1:
                break
            match = re.fullmatch(rb"([a-z0-9.-]+): ([1-9][0-9]{0,5}) OK", self.tail)
            if not self.oversized and match:
                group = match[1].decode("ascii")
                if group in self.expected:
                    yield group, int(match[2])
            self.tail = b""
            self.oversized = False


def group_present(child):
    try:
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def other_group_members(child):
    # Called only with an exited, unreaped leader. EOF does not prove that
    # descendants have left the group (they can close their output pipes).
    try:
        listing = subprocess.check_output(["ps", "-A", "-o", "pid,pgid"], env=EXECUTOR_ENV,
                                          stderr=subprocess.DEVNULL, timeout=1)
    except (OSError, subprocess.SubprocessError):
        return None
    group = str(child.pid).encode()
    members = set()
    for line in listing.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1] == group:
            members.add(fields[0])
    if group not in members:
        return None
    return len(members) > 1


def stop_group(child):
    # An unreaped session leader pins its numeric PGID, even after exiting.
    # Once we release that anchor the only permitted probe is signal zero.
    if child.returncode is None:
        try:
            os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            os.killpg(child.pid, signal.SIGTERM)
            until = time.monotonic() + 0.5
            while time.monotonic() < until:
                if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                    break
                time.sleep(POLL_SECONDS)
            exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if not exited or other_group_members(child) is not False:
                time.sleep(max(0, until - time.monotonic()))
                os.killpg(child.pid, signal.SIGKILL)
        except (ChildProcessError, ProcessLookupError, PermissionError):
            # Darwin can return EPERM for a group containing only our zombie.
            # Confirmation still requires reaping the leader and a missing group.
            pass
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            return "unconfirmed"
    until = time.monotonic() + 1
    while group_present(child) and time.monotonic() < until:
        time.sleep(POLL_SECONDS)
    return "unconfirmed" if group_present(child) else "confirmed"


def supervise(attempt, command, expected, interrupted):
    # No provider credentials, inherited log streams or client inputs.
    try:
        child = subprocess.Popen(command, cwd=ROOT, env=EXECUTOR_ENV,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return attempt.event("terminal", outcome="launch_failed", verified=False)

    def stop(reason):
        try:
            attempt.event("stop_requested", reason=reason)
        finally:
            cancellation = stop_group(child)
        outcome = reason if cancellation == "confirmed" else "cancel_unconfirmed"
        return attempt.event("terminal", outcome=outcome, cancellation=cancellation,
                             exit_code=child.returncode, verified=cancellation == "confirmed")

    active = attempt.identity["policy"]["mode"] == "synthetic-stop"
    try:
        attempt.start(child.pid)
        lines = GroupLines(expected)
        with child.stdout, selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            eof = False
            status = None
            while True:
                if interrupted():
                    return stop("operator_stop")
                data = None
                if not eof and selector.select(POLL_SECONDS):
                    data = os.read(child.stdout.fileno(), 65536)
                    eof = not data
                elif eof:
                    time.sleep(POLL_SECONDS)
                # Sample the previous deadline before a late checkpoint resets the clock.
                limit = attempt.exceeded()
                if limit and attempt.limit is None:
                    attempt.limit = limit
                    if active:
                        return stop("limit_reached")
                    attempt.event("would_stop")
                if data:
                    for group, count in lines.feed(data):
                        attempt.checkpoint(group, count)

                if status is None:
                    exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    if not exited:
                        continue
                    if active and other_group_members(child):
                        return stop("executor_left_children")
                    status = child.wait()
                    if group_present(child):
                        return attempt.event("terminal", outcome="result_unconfirmed",
                                             reason="executor_left_children", exit_code=status, verified=False)
                if eof:
                    break
                if not selector.select(0):
                    return attempt.event("terminal", outcome="result_unconfirmed",
                                         reason="output_still_open", exit_code=status, verified=False)
        if status < 0:
            outcome = "executor_lost"
        elif status != 0:
            outcome = "failed"
        elif not expected or expected != attempt.checkpoints.keys():
            outcome = "result_unconfirmed"
        else:
            outcome = "passed"
        return attempt.event("terminal", outcome=outcome, exit_code=status,
                             verified=outcome in {"passed", "failed"})
    except BaseException:
        if active:
            stop_group(child)
        raise


def positive_ms(value):
    value = int(value)
    if value <= 0:
        raise argparse.ArgumentTypeError("expected a positive duration in milliseconds")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports", required=True, type=Path)
    parser.add_argument("--run-id", type=uuid.UUID, help="redelivery key (default: new UUID)")
    parser.add_argument("--synthetic-hang", action="store_true",
                        help="run the built-in hanging fixture with test-only deadlines")
    for option in ("attempt", "stage", "silence"):
        parser.add_argument(f"--observe-{option}-ms", type=positive_ms)
    args = parser.parse_args()
    run_id = str(args.run_id or uuid.uuid4())
    policy = dict(mode="observe-only", attempt_ms=args.observe_attempt_ms,
                  stage_ms=args.observe_stage_ms, silence_ms=args.observe_silence_ms)
    if args.synthetic_hang and any(value is not None for key, value in policy.items() if key != "mode"):
        parser.error("shadow limits apply only to Contracts")

    schemas = sorted(CONTRACTS.glob("*.schema.json"))
    expected = {path.name.removesuffix(".schema.json").removesuffix(".v1") for path in schemas}
    script = CONTRACTS / "check_examples.py"
    inputs = [script, *schemas, CONTRACTS / "claim-candidate.example.json"]
    stage = "contracts"
    if args.synthetic_hang:
        stage, policy = "synthetic-hang", SYNTHETIC_POLICY
        script = HERE / "synthetic_hang.py"
        inputs, expected = [script], {"fixture-ready"}
    digest = hashlib.sha256()
    for path in inputs:
        digest.update(path.name.encode() + b"\0" + hashlib.sha256(path.read_bytes()).digest())
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    # The validator executes under -I; observer-only PYTHONPATH/user-site packages
    # must not turn a redelivery into a hit for an incompatible interpreter.
    environment = dict(python=platform.python_version(), os=platform.system(), arch=platform.machine())
    if not args.synthetic_hang:
        probe = [sys.executable, "-I", "-B", str(HERE / "executor_env.py")]
        environment.update(json.loads(subprocess.check_output(probe, env=EXECUTOR_ENV, cwd=ROOT)))
    report = args.reports / f"{run_id}.jsonl"
    identity = dict(schema=1, run_id=run_id, attempt_id=1, stage=stage, policy=policy,
                    sha=sha, input_sha256=digest.hexdigest(), evidence=report.name,
                    environment=environment)
    interrupted = False

    def interrupt(_signal, _frame):
        nonlocal interrupted
        interrupted = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupt)
    # An inherited SIG_IGN would allow automatic reaping and release the PGID.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    args.reports.mkdir(mode=0o700, parents=True, exist_ok=True)
    print(report, flush=True)
    try:
        with open_report(report) as stream:
            row = previous_result(stream, identity, expected)
            if row is None:
                attempt = Attempt(stream, identity)
                row = supervise(attempt, [sys.executable, "-I", "-B", "-u", str(script)],
                                expected, lambda: interrupted)
    except BlockingIOError:
        print("Attempt already under observation", file=sys.stderr)
        return 2
    except ValueError:
        print("Invalid or incompatible existing report", file=sys.stderr)
        return 2
    print(row["outcome"])
    return 0 if row["outcome"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())

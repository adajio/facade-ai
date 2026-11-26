"""Linux process-level regressions. Run under a normal reaping init."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from observe import HERE, supervise
from report import Attempt


def until(probe, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        time.sleep(.01)
    raise AssertionError("condition not observed within the test deadline")


def members(group):
    result = []
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = stat.read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if int(fields[2]) == group:
            result.append(int(stat.parent.name))
    return result


@unittest.skipUnless(sys.platform == "linux", "Linux process ownership checks")
class LinuxLifecycle(unittest.TestCase):
    def test_exited_leader_cannot_hide_descendant_with_closed_pipes(self):
        program = ("import subprocess;subprocess.Popen(['sleep','3'],stdout=subprocess.DEVNULL);"
                   "print('ready: 1 OK')")
        with tempfile.TemporaryFile("w+b") as stream:
            policy = dict(mode="synthetic-stop", stage_ms=4000, attempt_ms=6000, silence_ms=None)
            row = supervise(Attempt(stream, {"policy": policy}), [sys.executable, "-uc", program],
                            {"ready"}, lambda: False)
        self.assertEqual((row["outcome"],row["cancellation"]), ("executor_left_children","confirmed"))
        self.assertEqual(members(row["process_group"]), [])

    def test_operator_stop_survives_a_failed_journal_write(self):
        with tempfile.TemporaryFile("w+b") as stream:
            policy = dict(mode="observe-only", stage_ms=None, attempt_ms=None, silence_ms=None)
            attempt = Attempt(stream, {"policy": policy})
            original = attempt.event
            def persist(event, **fields):
                if event == "stop_requested":
                    raise OSError("simulated unavailable evidence sink")
                return original(event, **fields)
            with patch.object(attempt, "event", side_effect=persist), self.assertRaises(OSError):
                supervise(attempt, ["sleep", "2"], set(), lambda: True)
            self.assertEqual(members(attempt.process_group), [])

    def test_term_then_kill_targets_only_the_still_owned_group(self):
        # The leader exits on TERM; the descendant ignores it, including after reparenting.
        descendant = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready: 1 OK',flush=True);time.sleep(20)"
        program = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{descendant!r}]);time.sleep(20)"
        real_killpg = os.killpg
        signals = []

        def audited_killpg(group, sig):
            if sig:
                try:
                    os.waitid(os.P_PID, group, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    owned = True
                except ChildProcessError:
                    owned = False
                signals.append((sig, owned))
            return real_killpg(group, sig)

        with tempfile.TemporaryFile("w+b") as stream, patch("observe.os.killpg", side_effect=audited_killpg):
            policy = dict(mode="synthetic-stop", stage_ms=4000, attempt_ms=6000, silence_ms=150)
            row = supervise(Attempt(stream, {"policy": policy}), [sys.executable, "-uc", program],
                            {"ready"}, lambda: False)
        self.assertEqual(row["cancellation"], "confirmed")
        self.assertEqual(members(row["process_group"]), [])
        self.assertEqual(signals, [(signal.SIGTERM, True), (signal.SIGKILL, True)])

    def test_observe_only_leaves_remaining_child_untouched(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryFile("w+b") as stream:
            completed = Path(temp) / "completed"
            worker = f"import time,pathlib;time.sleep(.3);pathlib.Path({str(completed)!r}).touch()"
            program = f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{worker!r}]); print('ready: 1 OK')"
            policy = dict(mode="observe-only", stage_ms=None, attempt_ms=None, silence_ms=None)
            row = supervise(Attempt(stream, {"policy": policy}), [sys.executable, "-uc", program],
                            {"ready"}, lambda: False)
            until(completed.exists)
            self.assertFalse(row["verified"])
            self.assertNotEqual(row["outcome"], "passed")

    @unittest.skipUnless(hasattr(os, "pidfd_open"), "requires Linux pidfds for test cleanup")
    def test_killed_observer_redelivery_and_fixture_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            run = str(uuid.uuid4())
            report = path / (run + ".jsonl")
            cmd = [sys.executable, "-B", str(HERE / "observe.py"), "--reports", directory,
                   "--run-id", run, "--synthetic-hang"]
            observer = subprocess.Popen(cmd, stdout=subprocess.DEVNULL)
            bystander = subprocess.Popen(["sleep", "20"], start_new_session=True)
            handles = []

            def checkpoint():
                if report.exists():
                    for line in report.read_bytes().splitlines(keepends=True):
                        if line.endswith(b"\n"):
                            event = json.loads(line)
                            if event["event"] == "checkpoint":
                                return event
            try:
                point = until(checkpoint)
                observer.send_signal(signal.SIGSTOP)
                group = point["process_group"]
                children = members(group)
                self.assertEqual(len(children), 2)
                for pid in children:
                    handles.append(os.pidfd_open(pid))
                self.assertEqual(subprocess.run(cmd, capture_output=True, timeout=3).returncode, 2)
                observer.kill()
                observer.wait(timeout=2)
                self.assertEqual(subprocess.run(cmd, capture_output=True, timeout=3).returncode, 1)
                recovered = report.read_bytes()
                rows = [json.loads(line) for line in recovered.splitlines()]
                self.assertEqual([r["event"] for r in rows], ["queued","started","checkpoint","terminal"])
                last = rows[-1]
                self.assertEqual((last["outcome"],last["checkpoint"],last["cancellation"],last["verified"]),
                                 ("observer_lost","fixture-ready","unconfirmed",False))
                self.assertEqual(subprocess.run(cmd, capture_output=True, timeout=3).returncode, 1)
                self.assertEqual(report.read_bytes(), recovered)
                self.assertIsNone(bystander.poll())
                until(lambda: not members(group))
            finally:
                if observer.poll() is None:
                    observer.kill()
                observer.wait()
                for fd in handles:
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.close(fd)
                bystander.terminate()
                bystander.wait()

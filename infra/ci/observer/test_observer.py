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
from unittest.mock import Mock, patch

from observe import GroupLines, HERE, group_present, stop_group, supervise
from report import Attempt, open_report, previous_result


class ObserverTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.path = self.directory / "attempt.jsonl"
        self.policy = dict(mode="synthetic-stop", attempt_ms=5000, stage_ms=4000, silence_ms=320)
        self.identity = dict(schema=1, run_id="test", attempt_id=1, stage="synthetic",
                             sha="a"*40, input_sha256="b"*64, environment={},
                             policy=self.policy, evidence=self.path.name)

    def run_fixture(self, stream, program, expected):
        attempt = Attempt(stream, self.identity)
        return supervise(attempt, [sys.executable, "-I", "-u", "-c", program],
                         set(expected), lambda: False)

    def events(self, path=None):
        return [json.loads(line) for line in (path or self.path).read_text().splitlines()]

    def cli(self, run_id):
        return [sys.executable, "-B", str(HERE / "observe.py"), "--reports", str(self.directory),
                "--run-id", str(run_id), "--synthetic-hang"]

    def test_queue_excluded_and_distinct_absolute_budgets(self):
        now = [10.0]
        with open_report(self.path) as stream:
            attempt = Attempt(stream, self.identity, lambda: now[0])
            now[0] += 60
            self.assertIsNone(attempt.exceeded())
            attempt.start(1234)
            now[0] += 2
            self.assertIsNone(attempt.exceeded())  # No reliable checkpoint yet.
            now[0] += 2.1
            self.assertEqual(attempt.exceeded(), "stage_ms")
            self.policy["attempt_ms"] = 3000
            self.assertEqual(attempt.exceeded(), "attempt_ms")
        self.assertEqual(self.events()[1]["queue_ms"], 60000)
        self.assertEqual(self.events()[1]["execution_ms"], 0)

    def test_progress_outlasts_silence_and_noise_is_not_evidence(self):
        names = ["first", "second", "third", "last"]
        script = ("import time\nfor name in ('first','second','third','last'):\n"
                  " print('/client/private?raw=SECRET'); print(name+': 2 OK'); time.sleep(.12)")
        with open_report(self.path) as stream:
            row = self.run_fixture(stream, script, names)
        self.assertGreater(row["execution_ms"], self.policy["silence_ms"])
        self.assertEqual((row["outcome"], row["examples"], row["groups"]), ("passed", 8, 4))
        self.assertNotIn("SECRET", self.path.read_text())
        self.assertNotIn(str(self.directory), self.path.read_text())

    def test_parser_rejects_oversize_unknown_incomplete_and_reassembles_split(self):
        parser = GroupLines({"first"})
        self.assertEqual(list(parser.feed(b"x"*200)), [])
        self.assertEqual(list(parser.feed(b"first: 5 OK\nsecret: 1 OK\nfirst: 0 OK\nfir")), [])
        self.assertEqual(list(parser.feed(b"st: 5 OK\nfirst: 5 OK")), [("first", 5)])

    def test_shadow_records_once_and_leaves_slow_work_alive(self):
        self.policy.update(mode="observe-only", stage_ms=50, silence_ms=20)
        with open_report(self.path) as stream:
            row = self.run_fixture(stream, "import time;time.sleep(.2);print('done: 1 OK')", ["done"])
        self.assertEqual((row["outcome"], row["limit"]), ("passed", "stage_ms"))
        events = [entry["event"] for entry in self.events()]
        self.assertEqual(events.count("would_stop"), 1)
        self.assertNotIn("stop_requested", events)

    def test_incomplete_evidence_and_dead_executor_never_pass(self):
        for script, expected in (("pass", "result_unconfirmed"),
                                 ("import os,signal;os.kill(os.getpid(),signal.SIGKILL)", "executor_lost"),
                                 ("raise SystemExit(3)", "failed")):
            with self.subTest(expected=expected), tempfile.TemporaryFile("w+b") as stream:
                row = self.run_fixture(stream, script, ["done"])
                self.assertEqual(row["outcome"], expected)

    def test_silent_stage_uses_absolute_limit_and_reaps_ignoring_leader(self):
        self.policy.update(stage_ms=400, silence_ms=20)
        script = "import signal,time;signal.signal(signal.SIGTERM, signal.SIG_IGN);time.sleep(60)"
        with open_report(self.path) as stream:
            row = self.run_fixture(stream, script, ["done"])
        self.assertEqual((row["outcome"], row["limit"], row["cancellation"], row["exit_code"]),
                         ("limit_reached", "stage_ms", "confirmed", -signal.SIGKILL))

    def test_cancel_confirmation_requires_group_disappearance(self):
        child = Mock(pid=12345)
        with patch("observe.os.killpg", side_effect=PermissionError):
            self.assertTrue(group_present(child))
            self.assertEqual(stop_group(child), "unconfirmed")
        # Model an unavailable confirmation after a real cleanup, without leaking a child.
        def cannot_verify(child):
            self.assertEqual(stop_group(child), "confirmed")
            return "unconfirmed"
        self.policy.update(stage_ms=50)
        with patch("observe.stop_group", side_effect=cannot_verify), open_report(self.path) as stream:
            row = self.run_fixture(stream, "import time;time.sleep(60)", ["done"])
        self.assertEqual((row["outcome"], row["cancellation"], row["verified"]),
                         ("cancel_unconfirmed", "unconfirmed", False))

    def test_abandoned_attempt_keeps_checkpoint_and_has_one_terminal_even_after_torn_write(self):
        with open_report(self.path) as stream:
            attempt = Attempt(stream, self.identity)
            attempt.start(1234)
            attempt.checkpoint("first", 2)
            stream.write(b'{"partial"')
        with open_report(self.path) as stream:
            row = previous_result(stream, self.identity)
            self.assertEqual((row["outcome"], row["checkpoint"]), ("observer_lost", "first"))
            self.assertEqual(previous_result(stream, self.identity), row)
            with self.assertRaises(ValueError):
                previous_result(stream, {**self.identity, "input_sha256": "c"*64})
        self.assertEqual([r["event"] for r in self.events()].count("terminal"), 1)

    def test_concurrent_cli_cannot_dispatch_or_modify_an_owned_attempt(self):
        run_id = uuid.uuid4()
        path = self.directory / f"{run_id}.jsonl"
        with open_report(path):
            other = subprocess.run(self.cli(run_id), capture_output=True, timeout=3)
            self.assertEqual(other.returncode, 2)
            self.assertIn(b"already under observation", other.stderr)
            self.assertEqual(path.read_bytes(), b"")

    def test_cli_live_journal_duplicate_delivery_and_independent_incident(self):
        first = uuid.uuid4()
        path = self.directory / f"{first}.jsonl"
        with subprocess.Popen(self.cli(first), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as cli:
            try:
                until = time.monotonic() + 4
                while not (path.exists() and b'"checkpoint":"fixture-ready"' in path.read_bytes()):
                    self.assertIsNone(cli.poll(), "fixture ended before its checkpoint")
                    self.assertLess(time.monotonic(), until)
                    time.sleep(.01)
                self.assertNotIn(b'"event":"terminal"', path.read_bytes())
                with self.assertRaises(BlockingIOError), open_report(path):
                    self.fail("duplicate observer held the lock")
                self.assertEqual(cli.wait(timeout=8), 1)
            finally:
                if cli.poll() is None:
                    cli.terminate()
        events = self.events(path)
        terminal = events[-1]
        self.assertEqual((terminal["checkpoint"], terminal["limit"], terminal["cancellation"]),
                         ("fixture-ready", "silence_ms", "confirmed"))
        self.assertEqual([e["event"] for e in events],
                         ["queued", "started", "checkpoint", "stop_requested", "terminal"])
        self.assertLess(terminal["execution_ms"], 4000)
        with self.assertRaises(ProcessLookupError):
            os.killpg(terminal["process_group"], 0)
        original = path.read_bytes()
        for run_id in (first, uuid.uuid4()):
            result = subprocess.run(self.cli(run_id), capture_output=True, timeout=8)
            self.assertEqual((result.returncode, result.stdout.splitlines()[-1]), (1, b"limit_reached"))
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(len(list(self.directory.glob("*.jsonl"))), 2)


if __name__ == "__main__":
    unittest.main()

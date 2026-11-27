import json
import tempfile
import unittest
from pathlib import Path

from report import Attempt, append, open_report, previous_result


class ReportRecoveryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "attempt.jsonl"
        self.identity = dict(schema=1, run_id="test", attempt_id=1, stage="contracts",
                             sha="a" * 40, input_sha256="b" * 64, evidence=self.path.name,
                             environment={}, policy=dict(mode="observe-only", attempt_ms=None,
                                                         stage_ms=None, silence_ms=None))

    def assert_rejected_unchanged(self, identity=None):
        original = self.path.read_bytes()
        with open_report(self.path) as stream, self.assertRaises(ValueError):
            previous_result(stream, self.identity if identity is None else identity)
        self.assertEqual(self.path.read_bytes(), original)

    def start_attempt(self, stream):
        attempt = Attempt(stream, self.identity)
        attempt.start(1234)
        return attempt

    def test_incompatible_report_keeps_torn_tail_untouched(self):
        with open_report(self.path) as stream:
            Attempt(stream, self.identity)
            stream.write(b'{"event":"star')
        self.assert_rejected_unchanged({**self.identity, "input_sha256": "c" * 64})

    def test_torn_first_line_does_not_establish_ownership(self):
        self.path.write_bytes(b'{"schema":1')
        self.assert_rejected_unchanged()

    def test_incomplete_json_object_is_rejected(self):
        with open_report(self.path) as stream:
            Attempt(stream, self.identity)
            append(stream, {"schema": 1})
            stream.write(b'{"event":"term')
        self.assert_rejected_unchanged()

    def test_mixed_identity_in_earlier_row_is_rejected(self):
        with open_report(self.path) as stream:
            Attempt(stream, {**self.identity, "attempt_id": 2})
            self.start_attempt(stream).checkpoint("group", 3)
        self.assert_rejected_unchanged()

    def test_terminal_passed_without_valid_result_fields_is_rejected(self):
        with open_report(self.path) as stream:
            attempt = self.start_attempt(stream)
            attempt.checkpoint("group", 3)
            attempt.event("terminal", outcome="passed", exit_code=1, verified=False)
        self.assert_rejected_unchanged()

    def test_terminal_passed_without_durable_checkpoint_is_rejected(self):
        with open_report(self.path) as stream:
            attempt = self.start_attempt(stream)
            attempt.event("terminal", outcome="passed", exit_code=0, verified=True,
                          checkpoint="unrecorded", groups=1, examples=3)
        self.assert_rejected_unchanged()

    def test_multiple_terminal_events_are_rejected(self):
        with open_report(self.path) as stream:
            attempt = self.start_attempt(stream)
            attempt.checkpoint("group", 3)
            row = attempt.event("terminal", outcome="passed", exit_code=0, verified=True)
            append(stream, row)
        self.assert_rejected_unchanged()

    def test_reuses_valid_result_and_repairs_torn_suffix(self):
        with open_report(self.path) as stream:
            attempt = self.start_attempt(stream)
            attempt.checkpoint("group", 3)
            terminal = attempt.event("terminal", outcome="passed", exit_code=0, verified=True)
            original = self.path.read_bytes()
            stream.write(b'{"event":"term')
        with open_report(self.path) as stream:
            self.assertEqual(previous_result(stream, self.identity), terminal)
            self.assertEqual(previous_result(stream, self.identity), terminal)
        self.assertEqual(self.path.read_bytes(), original)

    def test_reuses_unconfirmed_results_without_turning_them_into_success(self):
        results = (
            dict(outcome="result_unconfirmed", exit_code=0, verified=False),
            dict(outcome="result_unconfirmed", exit_code=0, verified=False, reason="executor_left_children"),
            dict(outcome="cancel_unconfirmed", exit_code=0, verified=False, cancellation="unconfirmed"),
        )
        for result in results:
            with self.subTest(result=result), tempfile.TemporaryFile("w+b") as stream:
                attempt = self.start_attempt(stream)
                attempt.checkpoint("group", 3)
                terminal = attempt.event("terminal", **result)
                self.assertEqual(previous_result(stream, self.identity), terminal)

    def test_recovers_abandoned_attempt_and_records_a_single_terminal(self):
        with open_report(self.path) as stream:
            attempt = self.start_attempt(stream)
            attempt.checkpoint("group", 3)
            stream.write(b'{"event":"term')
        with open_report(self.path) as stream:
            terminal = previous_result(stream, self.identity)
            self.assertEqual((terminal["outcome"], terminal["checkpoint"], terminal["verified"]),
                             ("observer_lost", "group", False))
            self.assertEqual(previous_result(stream, self.identity), terminal)
        events = [json.loads(line)["event"] for line in self.path.read_text().splitlines()]
        self.assertEqual(events, ["queued", "started", "checkpoint", "terminal"])

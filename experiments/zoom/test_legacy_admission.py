"""Offline checks for the one-time OpenRouter budget migration."""

import json
from pathlib import Path
import tempfile
import unittest

from experiments.zoom.legacy_admission import LEGACY_BUDGET_FAILURE, certify_unsubmitted_budget
from experiments.zoom.session import KnownProviderFailure, run_session
from experiments.zoom.test_session import response


class LegacyAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def run_loop(self, send):
        return run_session(self.root, initial_messages=[{"role":"user","content":"Synthetic"}],
                           request_options={"model":"synthetic/model"}, send=send,
                           execute_tool=lambda *_: [], max_tool_rounds=1)

    def make_legacy_budget_refusal(self, detail=None):
        def refuse(*_):
            raise KnownProviderFailure(detail or LEGACY_BUDGET_FAILURE["detail"])

        self.run_loop(refuse)
        # Simulate the previous on-disk version, preserving its full evidence.
        (self.root / "attempts/0001/dispatches").rename(self.root / "fixture-new-dispatches")
        ledger = self.root / "charges.json"
        ledger.write_text("{}")
        return ledger

    def test_exact_legacy_budget_refusal_can_be_certified_without_deletion(self):
        ledger = self.make_legacy_budget_refusal()
        failure = self.root / "attempts/0001/failure.json"
        old_failure = failure.read_bytes()
        certify_unsubmitted_budget(self.root, 1, ledger_path=ledger, ledger_key="attempts/0001")
        self.assertEqual(failure.read_bytes(), old_failure)
        result = self.run_loop(lambda *_: response(content="42 mm"))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(failure.read_bytes(), old_failure)
        replay = self.run_loop(lambda *_: self.fail("Completed request resent"))
        self.assertEqual(replay["external_calls_started_this_run"], 0)

    def test_legacy_certification_rejects_reserved_attempt(self):
        ledger = self.make_legacy_budget_refusal()
        ledger.write_text(json.dumps({"attempts/0001": {"reserve": "0.10"}}))
        with self.assertRaisesRegex(ValueError, "reservation"):
            certify_unsubmitted_budget(self.root, 1, ledger_path=ledger, ledger_key="attempts/0001")
        self.assertFalse((self.root / "attempts/0001/admission-certificate.json").exists())
        result = self.run_loop(lambda *_: self.fail("Reserved refusal resent"))
        self.assertEqual(result["status"], "provider_failed")

    def test_legacy_certification_rejects_other_known_provider_failure(self):
        ledger = self.make_legacy_budget_refusal("HTTP 429")
        with self.assertRaisesRegex(ValueError, "exact legacy"):
            certify_unsubmitted_budget(self.root, 1, ledger_path=ledger, ledger_key="attempts/0001")

    def test_unknown_after_legacy_readmission_does_not_reuse_certificate(self):
        ledger = self.make_legacy_budget_refusal()
        certify_unsubmitted_budget(self.root, 1, ledger_path=ledger, ledger_key="attempts/0001")

        def unknown(*_):
            raise TimeoutError()

        self.assertEqual(self.run_loop(unknown)["status"], "outcome_unknown")
        self.assertEqual(self.run_loop(lambda *_: self.fail("Certificate reused"))["status"], "outcome_unknown")


if __name__ == "__main__":
    unittest.main()

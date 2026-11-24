"""Boundaries of semantic retrieval and resuming a paid question review."""

import json
import tempfile
import unittest
from pathlib import Path

from experiments.package_review.two_facades import (
    FIRST_BATCH,
    compare_question,
    make_reader,
    submit,
    write_originals,
)


class QuestionRecoveryTest(unittest.TestCase):
    def setUp(self):
        path = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.files = write_originals(path / "originals", FIRST_BATCH)
        self.state = path / "state"

    def run_upload(self, reader):
        report = json.loads(submit(reader, self.files, self.state).read_bytes())
        return {q["id"]: q for q in report["questions"]}

    def test_unknown_review_isolated_and_recovered_without_resend(self):
        called = []

        def compare(case):
            called.append(case["question"]["id"])
            if case["question"]["id"] == "a-thickness":
                raise OSError("lost response")
            return compare_question(case)

        reader = make_reader(compare=compare)
        first = self.run_upload(reader)
        self.assertEqual(first["a-thickness"]["status"], "needs_review")
        self.assertEqual(first["b-details"]["status"], "covered")

        def unavailable(_):
            raise OSError("gateway reconciliation unavailable")

        reader.restore_question = unavailable
        held = self.run_upload(reader)
        self.assertIn(
            "reconciliation unavailable", held["a-thickness"]["gateway_diagnostic"]
        )
        reader.restore_question = lambda case: {
            **compare_question(case),
            "receipt": "reconciled/trial",
        }
        repaired = self.run_upload(reader)
        self.assertEqual(repaired["a-thickness"]["status"], "conflict")
        self.assertEqual(called.count("a-thickness"), 1)

    def test_semantic_index_is_scope_bound_and_cannot_modify_source_lines(self):
        reader = make_reader()

        def index(question, facts):
            if question["id"] == "b-details":
                return {"missing-id": "untrusted external address"}
            chosen = {
                f["id"]: "candidate nominated from original"
                for f in facts
                if f["document_role"] == "register"
            }
            for f in facts:
                f["original_lines"] = ["altered"]
            return chosen

        reader.semantic_search = index
        current = self.run_upload(reader)
        self.assertEqual(current["b-details"]["status"], "needs_review")
        self.assertIn("ungrounded", current["b-details"]["reason"])
        self.assertEqual(current["a-details"]["status"], "missing")
        self.assertTrue(
            all(
                f["retrieval"] == "semantic_index"
                and f["original_lines"] != ["altered"]
                for f in current["a-details"]["evidence"]
            )
        )

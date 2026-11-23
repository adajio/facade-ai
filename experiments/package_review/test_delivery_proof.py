import json
import unittest

from experiments.package_review.delivery_proof import (
    common_attestation,
    validate_delivery,
)
from experiments.package_review.dispute_review import DisputeReview


class DeliveryProofTests(unittest.TestCase):
    def setUp(self):
        self.lines = ["Схема Х не передана.", "Лист Y передан. Размер не читается."]
        self.package = {
            "stage": "РД",
            "questions": [{"id": "q", "subject": "Схема", "scope": "А"}],
            "docs": [
                {
                    "id": "D",
                    "title": "Акт",
                    "units": [{"id": "u", "title": "Состав", "lines": self.lines}],
                }
            ],
        }

    def opinion(self, line):
        return {
            "question_id": "q",
            "status": "missing",
            "reason": "Проверена опись.",
            "request": "Просим предоставить схему Х.",
            "decisive": [1],
            "evidence": [{"unit": "u", "line": line, "quote": self.lines[line - 1]}],
        }

    def run_proof(self, result, *, fail=False):
        def call(model, lane, turn, system, inputs):
            if not inputs["opened"]:
                return json.dumps({"open": ["u"]})
            if lane.startswith("delivery-"):
                self.assertFalse(inputs["reports"])
                if fail and model == "Qwen":
                    raise RuntimeError("network hold")
                return json.dumps({"answers": [result]})
            return json.dumps(
                {"answers": [self.opinion(result["evidence"][0]["line"])]}
            )

        return DisputeReview(self.package, call, "Qwen").run()

    def test_positive_receipt_preserves_external_question(self):
        row = self.opinion(1)
        row["delivery"] = {
            "state": "not_delivered",
            "kind": "document",
            "target": "схема Х",
            "attestation": 1,
            "object_quote": "Схема Х",
        }
        out = self.run_proof(row)
        self.assertEqual(out["letter"][0]["citations"][0]["quote"], self.lines[0])
        self.assertEqual(out["questions"][0]["reason"], "current_non_delivery_attested")
        held = self.run_proof(row, fail=True)
        self.assertEqual(held["questions"][0]["status"], "needs_review")
        self.assertFalse(held["letter"])

    def test_delivered_but_unreadable_survives_in_card_without_request(self):
        row = self.opinion(2)
        row.update(
            status="needs_review",
            request=None,
            delivery={
                "state": "received_unreadable",
                "kind": "information",
                "target": "размер",
                "attestation": None,
            },
        )
        out = self.run_proof(row)
        card = out["questions"][0]
        self.assertFalse(out["letter"])
        self.assertEqual(card["status"], "needs_review")
        self.assertEqual(card["positions"][0]["status"], "missing")
        self.assertEqual(
            card["positions"][-1]["delivery"]["state"], "received_unreadable"
        )
        self.assertEqual(card["decision_evidence"][0]["rows"], [2])

    def test_other_object_in_same_register_line_cannot_match(self):
        row = self.opinion(1)
        row["evidence"][0]["quote"] = "Узел X, узел Y — к передаче."
        a = {
            **row,
            "delivery": {
                "state": "not_delivered",
                "kind": "document",
                "target": "X",
                "attestation": 1,
                "object_quote": "Узел X",
            },
        }
        b = {
            **row,
            "delivery": {**a["delivery"], "target": "Y", "object_quote": "узел Y"},
        }
        for r in (a, b):
            validate_delivery(r)
        self.assertFalse(common_attestation([a, b]))

    def test_two_lines_of_one_receipt_must_be_endorsed_in_both_directions(self):
        row = self.opinion(1)
        row["evidence"].append(
            {"unit": "u", "line": 2, "quote": "После среза досылок нет."}
        )
        row["decisive"] = [1, 2]
        a = {
            **row,
            "delivery": {
                "kind": "document",
                "state": "not_delivered",
                "target": "Х",
                "object_quote": "Схема Х",
                "attestation": 1,
            },
        }
        b = {**row, "delivery": {**a["delivery"], "attestation": 2}}
        self.assertTrue(common_attestation([a, b]))
        self.assertFalse(common_attestation([a, {**b, "decisive": [2]}]))
        self.assertFalse(common_attestation([{**a, "decisive": [1]}, b]))

    def test_prefix_of_another_identifier_is_a_different_deliverable(self):
        row = self.opinion(1)
        row["evidence"][0]["quote"] = "Схема Х1 и схема Х10 не переданы."
        a = {
            **row,
            "delivery": {
                "state": "not_delivered",
                "kind": "document",
                "target": "Х1",
                "attestation": 1,
                "object_quote": "Х1",
            },
        }
        b = {
            **row,
            "delivery": {**a["delivery"], "target": "Х10", "object_quote": "Х10"},
        }
        self.assertFalse(common_attestation([a, b]))

    def test_unknown_or_invalid_reference_cannot_authorize_missing(self):
        for loc, state in (
            (1, "unknown"),
            (5, "not_delivered"),
            (True, "not_delivered"),
        ):
            row = self.opinion(1)
            row["delivery"] = {
                "state": state,
                "kind": "document",
                "target": "схема Х",
                "attestation": loc,
                "object_quote": "Схема Х",
            }
            with self.assertRaises(ValueError):
                validate_delivery(row)

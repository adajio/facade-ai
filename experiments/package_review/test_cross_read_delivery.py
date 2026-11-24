import unittest

from experiments.package_review.cross_read_delivery import (
    agreed_quantities,
    engineer_handoff,
)


class DeliveryTest(unittest.TestCase):
    def test_equal_totals_do_not_hide_different_row_counts(self):
        def observations(parts):
            return {"sources": [{"ref": "schedule", "amounts": parts, "total": 8}]}

        one = observations([["BOX", 6], ["BOX.2", 2]])
        other = observations([["BOX", 5], ["BOX.2", 3]])
        self.assertIsNotNone(agreed_quantities({"A": one, "B": other})[1])
        self.assertEqual(
            agreed_quantities({"A": one, "B": one})[0]["schedule"]["rows"]["BOX.2"], 2
        )

    def test_no_customer_letter_from_shared_name_without_evidence(self):
        case = {
            "id": "c",
            "rev": "r",
            "version": 2,
            "state": "open",
            "topic": "some item",
            "origin": ["a", "b"],
            "basis": [],
            "result": {"proposal": {"text": "request", "stage": "estimate"}},
        }
        report = engineer_handoff("r", [case], [], [])
        self.assertEqual(report["drafts"], [])
        self.assertTrue(report["comparisons"][0]["held_question"])

    def test_cross_checked_model_count_must_occur_in_original_lines(self):
        from experiments.package_review.cross_read_delivery import question_evidence

        material = {"a": "T5   2 mounting clips", "b": "T5   2 mounting clips"}
        side = [{"ref": k, "lines": [0], "amounts": [["T5", 3]]} for k in material]
        case = {
            "a": "a",
            "b": "b",
            "result": {"answers": {m: {"sources": side} for m in ("M", "N")}},
        }
        reviews = {
            m: {
                "verdict": "supported",
                "reason": "match",
                "proofs": [
                    {"ref": k, "lines": [0], "reason": "quantity in row"}
                    for k in material
                ],
            }
            for m in ("M", "N")
        }
        check = lambda: question_evidence(
            case, reviews, lambda r, i: material.get(r), lambda r: r
        )
        self.assertEqual(check(), "unlocated_quantity_or_label")
        side[0]["amounts"][0][1] = 2
        side[1]["amounts"][0][1] = 2
        self.assertIsNone(check())
        reviews["M"]["proofs"][0].pop("reason")
        self.assertEqual(check(), "missing_reason_at_either_original")

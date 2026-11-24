import json
import tempfile
import unittest
from copy import deepcopy

from experiments.package_review.conflict_basis import sides
from experiments.package_review.dispute_review import DisputeReview, PositionSession


class ContinuationTests(unittest.TestCase):
    def setUp(self):
        self.package = {
            "stage": "РД",
            "questions": [{"id": q, "scope": "Юг", "subject": q} for q in ("x", "y")],
            "docs": [
                {
                    "id": doc,
                    "title": doc,
                    "units": [{"id": unit, "title": unit, "lines": [line]}],
                }
                for doc, unit, line in (
                    ("A", "u", "Проектный зазор 12 мм."),
                    ("B", "v", "Проектный зазор 15 мм."),
                    ("R", "w", "Оба листа действуют для юга."),
                )
            ],
        }
        self.evidence = [
            {"unit": u["id"], "line": 1, "quote": u["lines"][0]}
            for d in self.package["docs"]
            for u in d["units"]
        ]
        self.conflict = {
            "question_id": "x",
            "status": "conflict",
            "reason": "Оба источника действуют.",
            "request": "Просим согласовать зазор для юга.",
            "decisive": [1, 2],
            "evidence": self.evidence,
        }
        self.covered = {
            "question_id": "y",
            "status": "covered",
            "reason": "Листы применимы.",
            "request": None,
            "decisive": [1],
            "evidence": self.evidence[2:],
        }
        self.calls = []

    def call(self, model, lane, turn, system, inputs):
        self.calls.append((lane, inputs))
        if not inputs["opened"]:
            return json.dumps({"open": ["u", "v", "w"]})
        row = deepcopy(self.conflict)
        if lane.startswith("read-"):
            if model == "Kimi":
                row["decisive"].append(3)
            return json.dumps({"answers": [row, self.covered]})
        if lane.startswith("mediate-") or (
            lane.startswith("check-") and model == "Kimi"
        ):
            row["decisive"].append(3)
        if lane.startswith("opposed-"):
            row["conflict_basis"] = {
                "sides": [{"pin": 1, "value": "12 мм"}, {"pin": 2, "value": "15 мм"}],
                "applicability": [3],
            }
            if model == "Qwen":
                row["conflict_basis"]["sides"].reverse()
        return json.dumps({"answers": [row]})

    def test_confirm_the_same_two_values_despite_context_priority_and_side_order(self):
        result = DisputeReview(self.package, self.call, "Kimi").run()
        self.assertEqual(result["questions"][0]["reason"], "same_opposed_source_values")
        self.assertCountEqual(
            [e["document"] for e in result["letter"][0]["citations"]], ["A", "B", "R"]
        )
        self.assertEqual(len([l for l, _ in self.calls if l.startswith("opposed-")]), 2)

    def test_no_request_if_value_is_equal_after_unit_conversion_or_its_unit_was_dropped(
        self,
    ):
        owners = {"u": "A", "v": "B", "w": "R"}
        for inner in (False, True):
            row = deepcopy(self.conflict)
            row["evidence"][1]["quote"] = "Проектный зазор 0,012 м."
            row["conflict_basis"] = {
                "sides": [
                    {"pin": 1, "value": "12" if inner else "12 мм"},
                    {"pin": 2, "value": "0,012" if inner else "0,012 м"},
                ],
                "applicability": [3],
            }
            with self.assertRaises(ValueError):
                sides(row, owners)

    def test_resume_only_unfinished_question_with_own_sources_and_reuse_on_restart(
        self,
    ):
        def adapter(model, lane, turn, system, inputs):
            if lane == "read-Kimi" and inputs["opened"]:
                broken = deepcopy(self.conflict)
                broken.pop("reason")
                return json.dumps({"answers": [broken, self.covered]})
            if lane == "resume-x-Kimi":
                self.calls.append((lane, inputs))
                return json.dumps({"answers": [self.conflict]})
            return self.call(model, lane, turn, system, inputs)

        with tempfile.TemporaryDirectory() as tmp:

            def engine():
                return DisputeReview(
                    self.package,
                    adapter,
                    "Qwen",
                    checkpoint=tmp,
                    route_revision="fixed",
                )

            outcome = engine().run()
            self.assertEqual(outcome["questions"][0]["status"], "conflict")
            self.assertEqual(outcome["questions"][1]["status"], "covered")
            calls = [inputs for lane, inputs in self.calls if lane == "resume-x-Kimi"]
            self.assertEqual(len(calls), 1)
            self.assertEqual(set(calls[0]["opened"]), {"u", "v", "w"})
            self.assertEqual(
                [q["id"] for q in calls[0]["inventory"]["questions"]], ["x"]
            )
            self.assertEqual(list(calls[0]["reports"][0]), ["own_unfinished_position"])
            self.assertEqual(
                outcome["questions"][0]["positions"][0]["status"], "unavailable"
            )
            count = len(self.calls)
            again = engine().run()
            self.assertEqual(again, outcome)
            self.assertEqual(len(self.calls), count)

    def test_archived_covered_draft_without_optional_request(self):
        trial = PositionSession(self.package, None, "Kimi")
        row = {k: v for k, v in self.covered.items() if k not in {"reason", "request"}}
        with self.assertRaisesRegex(ValueError, "reason"):
            trial.checked({"answers": [row]}, {"u", "v", "w"}, False)
        self.assertIsNone(trial.drafts["y"]["request"])

    def test_common_printed_qualifier_preserves_units_and_different_conditions_hold(
        self,
    ):
        owners = {"u": "A", "v": "B", "w": "R"}
        row = deepcopy(self.conflict)
        row["evidence"][0]["quote"] = "12 мм после обработки"
        row["evidence"][1]["quote"] = "15 мм после обработки"
        row["conflict_basis"] = {
            "sides": [
                {"pin": i + 1, "value": e["quote"]}
                for i, e in enumerate(row["evidence"][:2])
            ],
            "applicability": [3],
        }
        self.assertEqual(len(sides(row, owners)), 2)
        row["evidence"][1]["quote"] = "15 мм до обработки"
        row["conflict_basis"]["sides"][1]["value"] = row["evidence"][1]["quote"]
        with self.assertRaises(ValueError):
            sides(row, owners)

    def test_rejected_citation_cannot_erase_valid_row(self):
        trial = PositionSession(self.package, None, "Kimi")
        broken = deepcopy(self.conflict)
        broken["evidence"][0]["quote"] = "not in source"
        for row in (self.conflict, broken):
            with self.assertRaises(ValueError):
                trial.checked({"answers": [row]}, {"u", "v", "w"}, True)
        self.assertEqual(trial.partial["x"], self.conflict)

    def test_pair_shares_unknown_continuation_without_new_dispatch(self):
        attempts = []

        def adapter(model, lane, turn, system, inputs):
            if lane == "read-Kimi" and inputs["opened"]:
                bad = deepcopy(self.conflict)
                bad.pop("reason")
                return json.dumps({"answers": [bad, self.covered]})
            if lane == "resume-x-Kimi":
                attempts.append(turn)
                raise RuntimeError("gateway receipt unknown")
            return self.call(model, lane, turn, system, inputs)

        result = DisputeReview(self.package, adapter, "Qwen").run_pair()
        self.assertEqual(attempts, [1])
        for mode in ("baseline", "conditional"):
            self.assertFalse(result[mode]["letter"])
            self.assertEqual(result[mode]["questions"][0]["status"], "needs_review")

    def test_partial_row_remains_valid_after_only_explanation_is_omitted(self):
        trial = PositionSession(self.package, None, "Kimi")
        for row in (
            self.conflict,
            {k: v for k, v in self.conflict.items() if k != "reason"},
        ):
            with self.assertRaises(ValueError):
                trial.checked({"answers": [row]}, {"u", "v", "w"}, True)
        self.assertEqual(trial.partial["x"], self.conflict)

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from experiments.package_review.autonomy_trial import parse
from experiments.package_review.dispute_review import DisputeReview, grounded_text


class DisputeReviewTest(unittest.TestCase):
    def setUp(self):
        self.package = {
            "stage": "РД",
            "questions": [{"id": "x", "subject": "Высота", "scope": "Юг"}],
            "docs": [
                {
                    "id": doc,
                    "title": doc,
                    "units": [{"id": unit, "title": unit, "lines": [line]}],
                }
                for doc, unit, line in (
                    ("А", "u", "Юг: 10 мм"),
                    ("Б", "v", "Юг: 15 мм"),
                )
            ],
        }
        self.seen = []
        self.responses = {}
        self.conflict = self.answer("conflict", "uv")
        self.covered = self.answer("covered", "u")
        self.uncertain = self.answer("needs_review", "v")

    def answer(self, status, keys):
        return {
            "question_id": "x",
            "reason": "Прочитанные строки",
            "status": status,
            "request": "Просим согласовать высоту на юге."
            if status == "conflict"
            else None,
            "decisive": list(range(1, len(keys) + 1)),
            "evidence": [
                {"unit": k, "line": 1, "quote": {"u": "10 мм", "v": "15 мм"}[k]}
                for k in keys
            ],
        }

    def call(self, model, lane, turn, prompt, inputs):
        self.seen.append((lane, turn, inputs))
        if lane in self.responses and isinstance(self.responses[lane], Exception):
            raise self.responses[lane]
        if set(inputs["opened"]) != {"u", "v"}:
            return json.dumps({"open": ["u", "v"]})
        answer = self.responses.get(lane, self.conflict)
        return json.dumps({"answers": [answer]})

    def test_prefixed_final_answer_is_recoverable_but_competing_answers_and_actions_are_not(
        self,
    ):
        content = json.dumps({"answers": [self.conflict]})
        self.assertEqual(parse("Проверено." + content), {"answers": [self.conflict]})
        for ambiguous in (
            content + " ответ " + content,
            'Пояснение: {"open":["u"]}',
            content + " далее",
        ):
            with self.assertRaises(ValueError):
                parse(ambiguous)

    def test_draft_includes_jointly_read_revision_and_correct_si_conversion(self):
        self.package["docs"][0]["units"][0]["lines"].append("Актуальна редакция 3.")
        revised = {
            **self.conflict,
            "evidence": [
                *self.conflict["evidence"],
                {"unit": "u", "line": 2, "quote": "Актуальна редакция 3."},
            ],
        }
        self.responses.update({"read-Kimi": revised, "read-Qwen": revised})
        out = DisputeReview(self.package, self.call, "Kimi").run()
        self.assertIn("Актуальна редакция 3.", out["draft"])
        self.assertEqual(out["letter"][0]["citations"][-1]["role"], "context")
        request = "Просим согласовать 42 мм или 46 мм."
        self.assertEqual(
            grounded_text(
                request,
                "conflict",
                self.package["questions"][0],
                [{"quote": "4,2 см"}, {"quote": "4,6 см"}],
            ),
            request,
        )

    def test_agreement_uses_no_lead_and_delivers_both_source_addresses(self):
        report = DisputeReview(self.package, self.call, "Kimi").run()
        self.assertFalse(report["sessions"])
        self.assertEqual({c[0] for c in self.seen}, {"read-Kimi", "read-Qwen"})
        self.assertTrue(
            all(not v["reports"] and not v["opened"] for _, t, v in self.seen if t == 1)
        )
        self.assertEqual(len(report["questions"][0]["positions"]), 2)
        self.assertIn("А / u, строка 1", report["draft"])
        self.assertIn("Б / v, строка 1", report["draft"])
        self.assertFalse(report["sent"])

    def test_one_dispute_can_add_a_supported_draft_without_losing_dissent(self):
        self.responses["read-Qwen"] = self.uncertain
        run = DisputeReview(self.package, self.call, "Qwen").run_pair()
        base, extra = run["baseline"], run["conditional"]
        self.assertEqual(base["draft"], "")
        self.assertEqual(base["questions"][0]["trigger"], "different_status")
        self.assertEqual(len(base["questions"][0]["evidence"]), 2)
        self.assertEqual(
            extra["questions"][0]["positions"][:2], base["questions"][0]["positions"]
        )
        self.assertEqual(extra["questions"][0]["status"], "conflict")
        self.assertEqual(
            [s["lane"] for s in extra["sessions"]],
            ["mediate-x", "check-x-Kimi", "check-x-Qwen"],
        )
        self.assertEqual(len(extra["letter"]), 1)

    def test_different_grounds_and_unresolved_reread_keep_both_positions(self):
        self.responses.update(
            {
                "read-Kimi": self.covered,
                "read-Qwen": self.answer("covered", "v"),
                "check-x-Qwen": self.uncertain,
            }
        )
        result = DisputeReview(self.package, self.call, "Kimi").run()
        row = result["questions"][0]
        self.assertEqual(
            (row["trigger"], row["status"]),
            ("different_decisive_evidence", "needs_review"),
        )
        self.assertEqual(
            [p["citations"][0]["document"] for p in row["positions"][:2]], ["А", "Б"]
        )
        self.assertFalse(result["draft"])

    def test_model_failure_is_visible_and_never_becomes_an_external_request(self):
        for failure in ("read-Kimi", "mediate-x", "check-x-Qwen"):
            with self.subTest(failure=failure):
                self.responses = {
                    "read-Qwen": self.uncertain,
                    failure: RuntimeError("transport held"),
                }
                result = DisputeReview(self.package, self.call, "Kimi").run()
                self.assertFalse(result["draft"])
                self.assertTrue(result["questions"][0]["evidence"])
                self.assertTrue(
                    any(
                        p["reason"] == "transport held"
                        for p in result["questions"][0]["positions"]
                    )
                )
                if failure == "read-Kimi":
                    self.assertFalse(result["sessions"])

    def test_manifest_substitution_or_unreadable_document_holds_before_call(self):
        with tempfile.TemporaryDirectory() as t:
            src = Path(t) / "doc"
            src.write_text("actual")
            args = {
                "reader": lambda _: {"id": "А", "units": []},
                "stage": "РД",
                "questions": self.package["questions"],
                "call": self.call,
                "lead": "Kimi",
            }
            with self.assertRaisesRegex(ValueError, "mismatched"):
                DisputeReview.from_upload({"А": src}, {"А": "bad"}, **args)
            with self.assertRaisesRegex(ValueError, "incomplete"):
                DisputeReview.from_upload(
                    {"А": src},
                    {"А": hashlib.sha256(src.read_bytes()).hexdigest()},
                    **args,
                )
            self.assertEqual(self.seen, [])

    def test_extra_support_reaches_engineer_and_invented_size_is_removed_from_draft(
        self,
    ):
        self.package["docs"][0]["units"][0]["lines"].append("Утверждено для Юг.")
        self.responses["read-Kimi"] = {
            **self.conflict,
            "request": "Просим согласовать 18 мм.",
        }
        self.responses["read-Qwen"] = {
            **self.conflict,
            "evidence": [
                *self.conflict["evidence"],
                {"unit": "u", "line": 2, "quote": "Утверждено для Юг."},
            ],
        }
        result = DisputeReview(self.package, self.call, "Kimi").run()
        row = result["questions"][0]
        self.assertFalse(result["sessions"])
        self.assertIn(
            "Утверждено для Юг.", [e["quote"] for e in row["decision_evidence"]]
        )
        self.assertNotIn("18 мм", result["draft"])
        self.assertIn("15 мм", result["draft"])

    def test_agreeing_on_uncertainty_with_disjoint_evidence_triggers_only_that_question(
        self,
    ):
        self.responses.update(
            {
                "read-Kimi": self.answer("needs_review", "u"),
                "read-Qwen": self.uncertain,
                "mediate-x": self.uncertain,
            }
        )
        result = DisputeReview(self.package, self.call, "Kimi").run()
        self.assertEqual(len(result["sessions"]), 1)
        self.assertFalse(result["letter"])
        self.assertEqual(result["questions"][0]["reason"], "mediator_unresolved")

    def test_mutation_by_caller_cannot_change_verified_source(self):
        trial = DisputeReview(self.package, self.call, "Qwen")
        self.package["docs"][0]["units"][0]["lines"][0] = "substitute"
        self.assertIn("10 мм", trial.run()["draft"])

    def test_stale_readings_do_not_trigger_new_calls(self):
        old = DisputeReview(self.package, self.call, "Kimi").independent()
        self.package["stage"] = "П"
        before = len(self.seen)
        with self.assertRaisesRegex(ValueError, "snapshot"):
            DisputeReview(self.package, self.call, "Kimi").assess(old, mediate=True)
        self.assertEqual(len(self.seen), before)

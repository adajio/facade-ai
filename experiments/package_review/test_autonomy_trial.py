"""Controls for navigation, delegation and the source-citation gate in the paired trial."""

import json
import unittest

from experiments.package_review.autonomy_trial import Trial


class AutonomyTrialTests(unittest.TestCase):
    def setUp(self):
        self.package = {
            "stage": "test",
            "questions": [
                {
                    "id": "q",
                    "scope": "north",
                    "subject": "check",
                    "rule": "read originals",
                }
            ],
            "docs": [
                {
                    "id": "d",
                    "title": "sheet",
                    "units": [{"id": "p", "title": "table", "lines": ["original row"]}],
                }
            ],
        }
        self.answer = {
            "answers": [
                {
                    "question_id": "q",
                    "status": "covered",
                    "evidence": [{"unit": "p", "line": 1, "quote": "original row"}],
                    "request": None,
                }
            ]
        }

    def test_mode_difference_is_visible_in_worker_inputs(self):
        for mode in ("B", "C"):
            seen = {}

            def call(model, lane, turn, system, inputs, captured=seen):
                captured[lane, turn] = json.loads(json.dumps(inputs))
                if lane == "lead" and turn == 1:
                    return json.dumps(
                        {"assign": [{"model": "Qwen", "task": "check drawing"}]}
                    )
                if "p" not in inputs["opened"]:
                    return json.dumps({"open": ["p"]})
                return json.dumps(self.answer)

            with self.subTest(mode=mode):
                result = Trial(self.package, call, "Kimi").run(mode)
                self.assertEqual(result["answers"], self.answer["answers"])
                self.assertEqual(
                    "original row" in json.dumps(seen.get(("lead", 1), {})), False
                )
                tasks = [e for e in result["events"] if e["action"] == "assign"]
                if mode == "C":
                    self.assertEqual(tasks[0]["jobs"][0]["model"], "Qwen")
                    self.assertEqual(
                        seen["lead-t1-w0", 1]["assignment"], "check drawing"
                    )
                else:
                    self.assertFalse(tasks)
                    for reader in ("Kimi", "Qwen"):
                        self.assertEqual(seen["read-" + reader, 1]["reports"], [])
                        self.assertEqual(seen["read-" + reader, 1]["opened"], {})

    def test_cannot_cite_an_unopened_unit_or_the_wrong_line(self):
        trial = Trial(self.package, None, "Kimi")
        with self.assertRaises(ValueError):
            trial.checked(self.answer, set(), True)
        self.answer["answers"][0]["evidence"][0]["quote"] = "unseen value"
        with self.assertRaises(ValueError):
            trial.checked(self.answer, {"p"}, True)

    def test_accept_only_unambiguous_addresses_inside_the_source_map(self):
        trial = Trial(self.package, None, "Kimi")
        for ref in ("p", "d", "d/p"):
            self.assertEqual(trial.resolve_open([ref]), {"p"})
        self.package["docs"][0]["units"].append(
            {"id": "t", "title": "next", "lines": ["x"]}
        )
        trial = Trial(self.package, None, "Kimi")
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            trial.resolve_open(["d"])
        with self.assertRaisesRegex(ValueError, "outside"):
            trial.resolve_open(["unrelated/p"])

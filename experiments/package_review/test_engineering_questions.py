from collections import Counter
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from experiments.package_review.two_facades import (
    ENGINEER,
    FIRST_BATCH,
    MODELS,
    SUPPLEMENT,
    compare_question,
    confirm_letter,
    extract_rows,
    make_reader,
    question_profile,
    submit,
    write_originals,
)


class TwoFacadesTest(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.initial = write_originals(root / "initial", FIRST_BATCH)
        self.supplement = write_originals(root / "supplement", SUPPLEMENT)
        self.state = root / "state"

    def test_same_scope_conflict_remains_in_letter_after_missing_details_arrive(self):
        cases = []

        def compare(case):
            cases.append(case)
            return compare_question(case)

        reader = make_reader(compare=compare)
        before_path = submit(reader, self.initial, self.state)
        before_bytes = before_path.read_bytes()
        before = json.loads(before_bytes)
        self.assertEqual(
            self.statuses(before),
            {"a-details": "missing", "a-thickness": "conflict",
             "b-details": "covered", "b-specification": "covered"},
        )
        self.assertEqual({q["question_id"] for q in before["letter"]}, {"a-details", "a-thickness"})
        self.assertEqual(before["decision"], "awaiting_engineer")

        actual_cases = {case["question"]["id"]: case for case in cases}
        self.assertEqual(len(cases), 4)
        self.assertEqual({case["kind"] for case in cases}, {"engineering_question"})
        self.assertEqual(set(actual_cases), set(self.statuses(before)))
        expected_pairs = {
            "a-details": {"A-register.txt"},
            "a-thickness": {"A-specification.txt", "A-requirements.txt"},
            "b-specification": {"B-specification.txt"},
            "b-details": {"B-details.txt"},
        }
        for question_id, names in expected_pairs.items():
            case = actual_cases[question_id]
            self.assertEqual({f["scope"] for f in case["facts"]}, {case["question"]["scope"]})
            self.assertEqual(
                {(f["unit"], f["model"]) for f in case["facts"]},
                {(f"{name}/page-1", model) for name in names for model in MODELS},
            )
        conflict = actual_cases["a-thickness"]
        self.assertEqual({f["label"] for f in conflict["facts"]}, {"AL-01", "Габарит обшивки по нормали"})
        self.assertEqual(
            {f["retrieval"] for f in conflict["facts"] if f["document_role"] == "requirements"},
            {"scope_role_context"},
        )
        self.assertEqual(
            {(f["model"], tuple(f["lines"])) for f in conflict["facts"] if f["document_role"] == "requirements"},
            {(model, (number,)) for model in MODELS for number in (1, 2)},
        )
        self.assertEqual({f["label"] for f in actual_cases["b-specification"]["facts"]}, {"AL-01"})

        self.assert_evidence(before, "a-details", {"A-register.txt"})
        self.assert_evidence(before, "a-thickness", {"A-specification.txt", "A-requirements.txt"})
        self.assert_evidence(before, "b-specification", {"B-specification.txt"})
        historical_letter = confirm_letter(reader, self.state, before)
        self.assertIn("направить установочные узлы фасада А", historical_letter["text"])
        self.assertIn("уточнить действующую толщину листа AL-01 фасада А", historical_letter["text"])
        self.assertNotIn("фасада Б", historical_letter["text"])
        self.assertIn("«Монтажные узлы будут переданы отдельно.»", historical_letter["text"])
        self.assertFalse(historical_letter["sent"])

        reader = make_reader(compare=compare)
        after_path = submit(reader, self.supplement, self.state)
        after = json.loads(after_path.read_bytes())
        self.assertEqual(self.statuses(after), {**self.statuses(before), "a-details": "covered"})
        self.assertEqual([q["question_id"] for q in after["letter"]], ["a-thickness"])
        self.assert_evidence(after, "a-details", set(SUPPLEMENT))
        self.assert_evidence(after, "a-thickness", {"A-specification.txt", "A-requirements.txt"})
        self.assert_evidence(after, "b-details", {"B-details.txt"})
        self.assertEqual(
            Counter(case["question"]["id"] for case in cases),
            Counter({qid: 1 + (qid == "a-details") for qid in expected_pairs}),
        )
        self.assertEqual(before_path.read_bytes(), before_bytes)
        latest_letter = confirm_letter(reader, self.state, after)
        self.assertIn("уточнить действующую толщину листа AL-01 фасада А", latest_letter["text"])
        self.assertNotIn("направить установочные узлы", latest_letter["text"])
        self.assertNotEqual(historical_letter["assessment_id"], latest_letter["assessment_id"])
        self.assertEqual(
            {
                (citation["unit"], tuple(citation["rows"]), citation["quote"])
                for line in latest_letter["lines"]
                for citation in line["citations"]
            },
            {("A-specification.txt/page-1", (2,), "2 мм"),
             ("A-requirements.txt/page-1", (2,), "0,003 м")},
        )
        with self.assertRaisesRegex(ValueError, "no longer current"):
            reader.confirm(self.state, before["assessment_id"], ["a-details"], ENGINEER)

        after_bytes = after_path.read_bytes()
        self.assertEqual(submit(reader, self.supplement, self.state), after_path)
        self.assertEqual(after_path.read_bytes(), after_bytes)
        self.assertEqual(len(cases), 5)
        saved = [
            json.loads(path.read_bytes())
            for path in (self.state / "engineering" / "conclusions").glob("*.json")
        ]
        self.assertCountEqual(saved, [historical_letter, latest_letter])

    def test_unverified_statement_cannot_create_external_request(self):
        for index, quote in enumerate(("Узлы никогда не передавались.", "Монтажные узлы")):
            with self.subTest(quote=quote):
                def unverified_compare(case):
                    answer = compare_question(case)
                    if case["question"]["id"] == "a-details":
                        for review in answer["reviews"].values():
                            review["attestation"]["quote"] = quote
                    return answer

                reader = make_reader(compare=unverified_compare)
                assessment = json.loads(
                    submit(reader, self.initial, self.state / str(index)).read_bytes()
                )
                self.assertEqual(self.statuses(assessment)["a-details"], "needs_review")
                self.assertEqual([q["question_id"] for q in assessment["letter"]], ["a-thickness"])

    def test_equal_thickness_in_different_units_cannot_create_conflict(self):
        profile = self.replace_requirements(FIRST_BATCH["A-requirements.txt"].replace("0,003 м", "0,002 м"))

        def spurious_conflict(case):
            answer = compare_question(case)
            if case["question"]["id"] == "a-thickness":
                for review in answer["reviews"].values():
                    reading = {
                        f["document_role"]: f["id"]
                        for f in case["facts"]
                        if f["id"] in review["basis"]
                    }
                    review.update(
                        status="conflict",
                        opposed=[{"fact": reading["spec"], "quote": "2 мм"},
                                 {"fact": reading["requirements"], "quote": "0,002 м"}],
                        reason="В оригиналах указаны разные числа.",
                    )
            return answer

        reader = make_reader(compare=spurious_conflict, profile=profile)
        assessment = json.loads(submit(reader, self.initial, self.state).read_bytes())
        self.assertEqual(self.statuses(assessment)["a-thickness"], "needs_review")
        self.assertEqual([q["question_id"] for q in assessment["letter"]], ["a-details"])

        state = self.state / "fully-covered"
        reader = make_reader(profile=profile)
        assessment = json.loads(submit(reader, self.initial | self.supplement, state).read_bytes())
        self.assertEqual(set(self.statuses(assessment).values()), {"covered"})
        conclusion = confirm_letter(reader, state, assessment)
        self.assertEqual(conclusion["state"], "no_letter")
        self.assertEqual(conclusion["text"], "")

    def test_other_execution_on_the_same_sheet_does_not_resolve_al_01(self):
        lines = FIRST_BATCH["A-requirements.txt"].splitlines(keepends=True)
        profile = self.replace_requirements(lines[0] + lines[2])
        reader = make_reader(profile=profile)
        assessment = json.loads(submit(reader, self.initial, self.state).read_bytes())
        thickness = next(q for q in assessment["questions"] if q["id"] == "a-thickness")
        self.assertEqual(thickness["status"], "needs_review")
        self.assertEqual(thickness["basis"], [])
        self.assertEqual(
            {f["text"] for f in thickness["evidence"] if f["document_role"] == "requirements"},
            {"Алюминиевый лист исполнения 02: 0,004 м."},
        )
        self.assertEqual([q["question_id"] for q in assessment["letter"]], ["a-details"])

    def test_mention_of_details_does_not_cover_obligation(self):
        def extract(job, lines):
            result = extract_rows(job, lines)
            if job["unit"] == "B-details.txt/page-1":
                result["observations"][0]["role"] = "mention"
            return result

        reader = make_reader(extract=extract)
        assessment = json.loads(submit(reader, self.initial, self.state).read_bytes())
        self.assertEqual(self.statuses(assessment)["b-details"], "needs_review")
        self.assertEqual({q["question_id"] for q in assessment["letter"]}, {"a-details", "a-thickness"})

    def test_replaced_content_cannot_inherit_approved_scope_from_filename(self):
        self.initial["A-register.txt"].write_text(FIRST_BATCH["B-details.txt"], encoding="utf-8")
        assessment = json.loads(submit(make_reader(), self.initial, self.state).read_bytes())
        self.assertEqual(self.statuses(assessment)["a-details"], "needs_review")
        self.assertNotIn("a-details", {q["question_id"] for q in assessment["letter"]})

    def replace_requirements(self, text):
        requirements = self.initial["A-requirements.txt"]
        requirements.write_text(text, encoding="utf-8")
        profile = question_profile()
        profile["documents"][requirements.name]["sha256"] = hashlib.sha256(
            requirements.read_bytes()
        ).hexdigest()
        return profile

    @staticmethod
    def statuses(assessment):
        return {q["id"]: q["status"] for q in assessment["questions"]}

    def assert_evidence(self, assessment, question_id, sources):
        question = next(q for q in assessment["questions"] if q["id"] == question_id)
        originals = FIRST_BATCH | SUPPLEMENT
        by_hash = {hashlib.sha256(originals[name].encode("utf-8")).hexdigest(): name for name in sources}
        evidence = [f for f in question["evidence"] if f["id"] in question["basis"]]
        self.assertEqual({f["source"] for f in evidence}, set(by_hash))
        for fact in evidence:
            source = by_hash[fact["source"]]
            self.assertEqual(fact["unit"], f"{source}/page-1")
            self.assertEqual(fact["lines"], [1])
            self.assertIn(fact["text"], originals[source].splitlines()[1])

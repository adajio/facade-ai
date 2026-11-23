"""Exercise the public upload entry with local source and inspection adapters."""

import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import patch

from experiments.package_review import ordinary_intake
from experiments.package_review.reconciliation_queue import ReconciliationQueue
from experiments.package_review.research import digest


READERS = ("local-A", "local-B")
ROSTER = "Aircraft museum: wing storage bay. Fixtures LUG-104 LUG-211 LUG-342 listed here."
DIFFERENT = ("Blue felt sleeve holding a flute near the loading bay.",
             "Keeper checked a green cloth case for an instrument on arrival.")


def quiet(*_args):
    return []


def addressed(task, units):
    return "different_scope", [
        {"reader": reader, "unit": unit, "location": "line 1", "reading": units[unit][0],
         "receipt": f"{reader}/{unit}/line-1"}
        for reader in task["readers"] for unit in task["units"]
    ], True


def proposal(units, reference, reason):
    a, b = list(units)[:2]
    return {"left": a, "right": b, "reference": reference, "reason": reason}


class OrdinaryUploadTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        self.state = self.root / "intake"
        self.files = {name: self.root / name for name in ("custody.txt", "storage.txt")}
        self.write(ROSTER + " Number of mounting clips 18.\n", ROSTER + " Number of mounting clips 27.\n")

    def write(self, first, second):
        for path, content in zip(self.files.values(), (first, second)):
            path.write_text(content, encoding="utf-8")

    @staticmethod
    def read(files, expected, prefix=""):
        return ({prefix + key: path.read_text().splitlines() for key, path in files.items()},
                {prefix + key: revision for key, revision in expected.items()})

    def manifest(self):
        return {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in self.files.items()}

    def upload(self, **changes):
        return ordinary_intake.ordinary_upload(**{
            "files": self.files, "expected": self.manifest(), "folder": self.state, "readers": READERS,
            "read": self.read, "survey": quiet, "screen": quiet, "inspect": addressed,
            "publish": lambda revision, tasks, issues: (revision, tasks, issues), **changes,
        })

    def tasks(self):
        with ReconciliationQueue(self.state / "work.sqlite") as queue:
            return queue.list_tasks(scope="package-intake", package_revision=ordinary_intake.verify_originals(
                self.files, self.manifest()))

    def test_structural_obligation_starts_before_screen_and_slow_survey(self):
        started = Event()
        observed = []

        def inspect(task, units):
            started.set()
            return addressed(task, units)

        def screen(groups, units):
            observed.extend(self.tasks())
            self.assertTrue(started.wait(2), "mandatory work must start while producers are pending")
            pair = groups[0][0]
            return [{**pair, "reference": "candidate-edges.json#0/0", "reason": "legacy structural echo"}]

        def survey(*_args):
            self.assertTrue(started.wait(2), "survey must not prevent work being assigned")
            return []

        _, tasks, issues = self.upload(screen=screen, survey=survey, inspect=inspect)
        self.assertEqual(issues, [])
        self.assertEqual(len(observed), 1)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["status"], "closed")
        self.assertEqual(len(tasks[0]["attempts"]), 1)
        self.assertEqual(len(tasks[0]["reasons"]), 1)
        self.assertEqual(len(tasks[0]["proposal_sources"]), 1)

    def test_existing_open_work_recovers_without_repeated_discovery(self):
        self.write(*DIFFERENT)

        def survey(reader, units):
            return [proposal(units, "survey/related", "possible related case")] if reader == READERS[0] else []

        def partial(task, units):
            _, evidence, _ = addressed(task, units)
            return "second reader unavailable", evidence[:2], False

        _, before, issues = self.upload(survey=survey, inspect=partial)
        self.assertEqual(issues, [])
        self.assertEqual(before[0]["status"], "open")
        self.assertEqual(len(before[0]["attempts"][0]["result"]["evidence"]), 2)
        _, after, issues = self.upload()
        self.assertEqual(issues, [])
        self.assertEqual(after[0]["task_id"], before[0]["task_id"])
        self.assertEqual(after[0]["status"], "closed")
        self.assertEqual([item["status"] for item in after[0]["attempts"]], ["failed", "closed"])
        _, repeat, _ = self.upload(inspect=lambda *_: self.fail("closed task must not run again"))
        self.assertEqual(repeat, after)

    def test_silent_replay_recovers_expired_claim_and_preserves_late_result_diagnostic(self):
        self.write(*DIFFERENT)
        now = [10_000]

        def queue_at_controlled_time(path):
            return ReconciliationQueue(path, clock=lambda: now[0])

        def survey(reader, units):
            return [proposal(units, "survey/pair", "possible relation")] if reader == READERS[0] else []

        def late(task, units):
            now[0] += 3600
            return addressed(task, units)

        with patch.object(ordinary_intake, "ReconciliationQueue", queue_at_controlled_time):
            _, stale, issues = self.upload(survey=survey, inspect=late)
            self.assertEqual(stale[0]["status"], "open")
            self.assertEqual(issues[0]["error"], "attempt is no longer assigned")
            _, recovered, issues = self.upload()
        self.assertEqual(issues, [])
        self.assertEqual(recovered[0]["status"], "closed")
        self.assertEqual([r["status"] for r in recovered[0]["attempts"]], ["expired", "closed"])

    def test_abrupt_stop_keeps_survey_initiative_and_only_expired_claim_is_retried(self):
        self.write(*DIFFERENT)
        now = [3000]

        def queue_at_controlled_time(path):
            return ReconciliationQueue(path, clock=lambda: now[0])

        def survey(reader, units):
            return [proposal(units, "survey/pair", "possible relation")] if reader == READERS[0] else []

        def interrupt(*_args):
            raise KeyboardInterrupt()

        with patch.object(ordinary_intake, "ReconciliationQueue", queue_at_controlled_time):
            with self.assertRaises(KeyboardInterrupt):
                self.upload(survey=survey, inspect=interrupt)
            _, early, _ = self.upload()
            self.assertEqual(early[0]["status"], "assigned")
            now[0] += 3600
            _, recovered, issues = self.upload()
        self.assertEqual(issues, [])
        self.assertEqual(recovered[0]["status"], "closed")
        self.assertEqual([r["status"] for r in recovered[0]["attempts"]], ["expired", "closed"])

    def test_persisted_survey_signal_survives_failure_before_queue_registration(self):
        self.write(*DIFFERENT)

        def survey(reader, units):
            return [proposal(units, "survey/pair", "possible relation")] if reader == READERS[0] else []

        with patch.object(ReconciliationQueue, "discover", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.upload(survey=survey)
        self.assertEqual(self.tasks(), [])
        _, tasks, issues = self.upload()
        self.assertEqual(issues, [])
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["status"], "closed")
        self.assertEqual(tasks[0]["reasons"][0]["reference"], "survey/pair")

    def test_invalid_unicode_in_a_proposal_cannot_poison_the_next_load(self):
        self.write(*DIFFERENT)
        invalid_text = chr(0xD800)

        def survey(reader, units):
            return [proposal(units, invalid_text, "possible relation")] if reader == READERS[0] else []

        _, tasks, issues = self.upload(survey=survey)
        self.assertEqual(tasks, [])
        self.assertEqual(len(issues), 1)
        _, tasks, issues = self.upload()
        self.assertEqual((tasks, issues), ([], []))

    def test_malformed_proposals_and_empty_inspection_failure_are_isolated(self):
        def survey(reader, units):
            if reader == READERS[0]:
                return None
            return ["unstructured", proposal(units, "survey/valid", "local concern")]

        def screen(*_args):
            raise RuntimeError("screen unavailable")

        def inspect(*_args):
            raise RuntimeError()

        _, tasks, issues = self.upload(survey=survey, screen=screen, inspect=inspect)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(len(tasks[0]["reasons"]), 2)
        self.assertEqual(tasks[0]["status"], "open")
        self.assertTrue(all(r["result"]["reason"] == "RuntimeError" for r in tasks[0]["attempts"]))
        self.assertEqual({issue["error"] for issue in issues}, {"screen unavailable", "RuntimeError",
            "source proposal envelope must be a list or tuple", "proposal must be an object"})

    def test_duplicate_late_provenance_does_not_reinspect(self):
        self.write(*DIFFERENT)

        def survey(reader, units):
            if reader == READERS[0]:
                return [proposal(units, "survey/first", "look at this same relation")]
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if any(task["status"] == "closed" for task in self.tasks()):
                    return [proposal(units, "survey/second", "  look at this   same relation  ")]
                time.sleep(.01)
            self.fail("a producer may publish a task before another one finishes")

        _, tasks, issues = self.upload(survey=survey)
        self.assertEqual(issues, [])
        self.assertEqual(len(tasks), 1)
        self.assertEqual(len(tasks[0]["attempts"]), 1)
        self.assertEqual(len(tasks[0]["reasons"]), 1)
        self.assertEqual([p["origin"] for p in tasks[0]["proposal_sources"]], list(READERS))

    def test_same_revision_rebinds_aliases_and_keeps_original_task_identity(self):
        def partial(task, units):
            return "reader unavailable", [], False

        revision, pending, _ = self.upload(inspect=partial)
        switched, tasks, issues = self.upload(read=lambda files, expected: self.read(files, expected, "alias/"))
        self.assertEqual(issues, [])
        self.assertEqual(switched, revision)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["task_id"], pending[0]["task_id"])
        self.assertEqual(tasks[0]["status"], "closed")
        self.assertEqual(tasks[0]["units"], pending[0]["units"])
        self.assertTrue(all(row["reader_unit_alias"] == "alias/" + row["unit"]
                            for row in tasks[0]["attempts"][-1]["result"]["evidence"]))

    def test_single_original_cannot_be_registered_as_an_inter_source_task(self):
        name = next(iter(self.files))
        self.files = {name: self.files[name]}

        def two_units(files, expected):
            return {"page-1": [ROSTER], "page-2": [ROSTER]}, dict.fromkeys(["page-1", "page-2"], expected[name])

        _, tasks, issues = self.upload(read=two_units,
            survey=lambda reader, units: [proposal(units, reader, "a misleading match")])
        self.assertEqual(tasks, [])
        self.assertEqual(len(issues), 2)
        self.assertTrue(all("distinct uploaded originals" in issue["error"] for issue in issues))

    def test_optional_semantic_screen_can_create_work_outside_structural_candidates(self):
        self.write(*DIFFERENT)
        revision, tasks, issues = self.upload()
        self.assertEqual((tasks, issues), ([], []))
        path = self.state / "revisions" / digest("package-intake") / revision / "unexamined-originals.json"
        coverage = json.loads(path.read_text())
        self.assertEqual(len(coverage), 1)
        self.assertEqual(coverage[0]["state"], "requires_semantic_survey")

        def semantic(unexamined, units):
            self.assertEqual(unexamined, coverage)
            return [proposal(units, "semantic/first", "The two sentences can describe the same sleeve")]

        _, tasks, issues = self.upload(semantic_screen=semantic)
        self.assertEqual(issues, [])
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["reasons"][0]["origin"], "semantic-screen")
        self.assertEqual(json.loads(path.read_text()), coverage)

    def test_revision_isolates_queue_and_archive_from_the_current_upload(self):
        old_revision, old_tasks, _ = self.upload(inspect=lambda *_: ("not located", [], False))
        self.write(*DIFFERENT)
        new_revision, new_tasks, _ = self.upload()
        self.assertNotEqual(new_revision, old_revision)
        self.assertEqual(new_tasks, [])
        with ReconciliationQueue(self.state / "work.sqlite") as queue:
            archived = queue.list_tasks(scope="package-intake", package_revision=old_revision)
        self.assertEqual(archived[0]["task_id"], old_tasks[0]["task_id"])
        self.assertEqual(archived[0]["status"], "open")
        archives = self.state / "revisions" / digest("package-intake")
        previous = json.loads((archives / old_revision / "candidate-edges.json").read_text())
        current = json.loads((archives / new_revision / "candidate-edges.json").read_text())
        self.assertEqual(len(previous), 1)
        self.assertEqual(current, [])

    def test_public_variant_subscriber_persists_plan_defers_and_retries_with_current_aliases(self):
        self.write(ROSTER + " Side member LUG-104.3.\n", ROSTER + " Side member LUG-104.4.\n")
        revision, tasks, issues = self.upload()
        directory = self.state / "revisions" / digest("package-intake") / revision
        plan = next(directory.rglob("variant-agenda.json"))
        results = plan.with_name("variant-results.json")
        agenda = json.loads(plan.read_text())["agenda"]
        self.assertEqual(len(agenda), 1)
        self.assertEqual(agenda[0]["task_id"], tasks[0]["task_id"])
        self.assertEqual(json.loads(results.read_text())[0]["status"], "open")
        check, = tasks[0]["variant_checks"]
        self.assertEqual(check["status"], "open")
        self.assertEqual(check["basis"]["reference"], tasks[0]["task_id"])
        self.assertEqual(check["reference"], f"{results.relative_to(self.state)}#{agenda[0]['work_id']}")
        self.assertEqual(issues, [])

        _, _, deferred = self.upload(inspect_variant=lambda *_: None)
        self.assertEqual(deferred, [])
        self.assertEqual(json.loads(results.read_text())[0]["status"], "open")

        def inspect_variant(case, units):
            self.assertTrue(all(unit.startswith("alias/") for unit in case["units"]))
            return addressed({**case, "readers": READERS}, units)

        _, tasks, issues = self.upload(read=lambda files, expected: self.read(files, expected, "alias/"),
                                       inspect_variant=inspect_variant)
        self.assertEqual(issues, [])
        closed = json.loads(results.read_text())[0]
        self.assertEqual(closed["status"], "closed")
        self.assertEqual(tasks[0]["variant_checks"][0]["status"], "closed")
        self.assertEqual(len(closed["attempts"]), 2)
        self.assertEqual(closed["task_id"], agenda[0]["work_id"])
        self.assertTrue(all(row["reader_unit_alias"] == "alias/" + row["unit"]
                            for row in closed["attempts"][-1]["result"]["evidence"]))
        _, _, issues = self.upload(inspect_variant=lambda *_: self.fail("completed variant must not run again"))
        self.assertEqual(issues, [])
        self.assertEqual(json.loads(results.read_text())[0], closed)

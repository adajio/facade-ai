"""Independent controls for automatic comparison of separate source readings."""

import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from experiments.package_review import cross_read
from experiments.package_review.ordinary_intake import ordinary_upload
from experiments.package_review.reading_flow import reading_flow
from experiments.package_review.source_jobs import located_observation, reading_jobs


class LocatedReadingControls(unittest.TestCase):
    def test_variant_does_not_prove_that_a_base_mark_was_read(self):
        lines = {2: "PMP-81.3   7 mounting clips", 3: "PMP-81   12 mounting clips"}
        self.assertIsNone(located_observation(["PMP-81", [2], "data", "7 clips"], lines))
        self.assertIsNone(located_observation(["81.3", [2], "data", "7 clips"], lines))
        base = located_observation(["PMP-81", [3], "data", "12 clips"], lines)
        variant = located_observation(["pmp-81.3", [2], "data", "7 clips"], lines)
        self.assertEqual(base["topic"], variant["topic"])
        self.assertEqual(variant["lines"], [2])

    def test_unpresented_line_cannot_supply_an_address(self):
        lines = {1: "PMP-81   12 mounting clips"}
        candidate = ["PMP-81", [1, 2], "data", "12 clips"]
        self.assertIsNone(located_observation(candidate, lines))
        self.assertIsNone(located_observation(["PMP-81", [True], "data", "12 clips"], lines))

    def test_windows_preserve_sparse_and_unranked_material(self):
        units = {
            "empty": [],
            "one": ["Original cabinet", "Six strips of beech", "Checked by inspector"],
            "two": ["PMP-81   12 mounting clips", "", "On loan to another hall"],
        }
        owners = {unit: "sha-" + unit for unit in units}
        jobs = reading_jobs(units, owners, width=24)
        for unit, lines in units.items():
            windows = [window for _, name, window in jobs if name == unit]
            self.assertTrue(windows, unit)
            self.assertEqual([i for window in windows for i, _ in window], list(range(len(lines))))


class CrossReadLedgerControls(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(TemporaryDirectory())

    def ledger(self, revision="delivery-1"):
        ledger = cross_read.ReadingLedger(self.directory, revision)
        self.addCleanup(ledger.db.close)
        return ledger

    @staticmethod
    def fact(source, job, **overrides):
        return {
            "source": source, "unit": source + "-page", "job": job, "topic": "pmp-81",
            "label": "PMP-81", "model": "reader-A", "receipt": f"{job}/sha256",
            "role": "data", "text": "Two mounting clips.", "lines": [4], **overrides,
        }

    def test_same_source_same_job_and_foreign_revision_cannot_start_comparison(self):
        first = self.ledger()
        first.ingest([self.fact("original-a", "job-1")])
        first.ingest([self.fact("original-a", "job-2")])
        self.assertIsNone(first.claim())
        other = self.ledger("delivery-2")
        other.ingest([self.fact("original-b", "job-3")])
        self.assertIsNone(other.claim())
        self.assertIsNone(first.claim())

        same_job = self.ledger("delivery-3")
        same_job.ingest([self.fact("original-a", "job-1"),
                         self.fact("original-b", "job-1", receipt="independent-intake/sha256")])
        self.assertIsNone(same_job.claim())

    def test_separate_persisted_jobs_create_one_recoverable_comparison(self):
        first = self.ledger()
        left = self.fact("original-a", "job-1")
        right = self.fact("original-b", "job-2", text="Three mounting clips.")
        first.ingest([left])
        self.assertIsNone(first.claim())
        second = self.ledger()
        second.ingest([right, right])
        self.assertEqual(len(second.snapshot()), 1)
        pending = second.snapshot()[0]
        facts = {row["id"]: row for row in second.readings()}
        self.assertEqual({facts[f]["job"] for f in pending["origin"]}, {"job-1", "job-2"})

        reopened = self.ledger()
        now = [1_000]
        with patch.object(cross_read.time, "time", side_effect=lambda: now[0]):
            first_claim = reopened.claim(lease=10)
            self.assertIsNone(second.claim(lease=10))
            now[0] += 11
            second_claim = second.claim(lease=10)
            self.assertEqual(second_claim["id"], first_claim["id"])
            self.assertEqual(second_claim["version"], first_claim["version"])
            self.assertNotEqual(second_claim["token"], first_claim["token"])
            with self.assertRaises(ValueError):
                reopened.finish(first_claim, {"state": "failed"})
            second.finish(second_claim, {"state": "reviewed"})
        second.ingest([left, right])
        self.assertIsNone(second.claim())
        self.assertEqual(second.snapshot()[0]["state"], "reviewed")

    def test_failed_batch_leaves_no_unprovable_obligation(self):
        ledger = self.ledger()
        ledger.ingest([self.fact("original-a", "job-1")])
        valid = self.fact("original-b", "job-2")
        invalid = self.fact("original-c", "job-3", receipt="")
        with self.assertRaises(ValueError):
            ledger.ingest([valid, invalid])
        self.assertEqual(len(ledger.readings()), 1)
        self.assertIsNone(ledger.claim())

    def test_one_receipt_can_support_multiple_labels_only_in_its_own_job(self):
        ledger = self.ledger()
        first = self.fact("original-a", "job-1")
        another = self.fact("original-a", "job-1", label="PMP-92", topic="pmp-92")
        ledger.ingest([first, another])
        transplanted = self.fact("original-b", "job-2", receipt=first["receipt"])
        with self.assertRaises(ValueError):
            ledger.ingest([transplanted])
        self.assertEqual(len(ledger.readings()), 2)
        self.assertIsNone(ledger.claim())

    def test_a_new_reading_during_a_lease_gets_its_own_attempt(self):
        ledger = self.ledger()
        ledger.ingest([self.fact("original-a", "job-1"), self.fact("original-b", "job-2")])
        prior = ledger.claim()
        ledger.ingest([self.fact("original-b", "job-3", text="Three mounting clips.")])
        self.assertIsNone(ledger.claim())
        ledger.finish(prior, {"state": "from_prior_reading"})
        self.assertEqual(ledger.snapshot()[0]["state"], "pending")
        later = ledger.claim()
        self.assertEqual(later["id"], prior["id"])
        self.assertGreater(later["version"], prior["version"])
        self.assertEqual({fact["job"] for fact in later["facts"]}, {"job-1", "job-2", "job-3"})

    def test_reconciled_retry_recovers_one_same_version_attempt(self):
        ledger = self.ledger()
        ledger.ingest([self.fact("original-a", "job-1"), self.fact("original-b", "job-2")])
        prior = ledger.claim()
        ledger.finish(prior, {"state": "deferred", "reason": "before transport"})
        self.assertIsNone(ledger.claim())
        reopened = self.ledger()
        reopened.retry(prior["id"], prior["version"], "confirmed no provider dispatch")
        reopened.retry(prior["id"], prior["version"], "repeat authorization")
        later = reopened.claim()
        self.assertEqual((later["id"], later["version"]), (prior["id"], prior["version"]))
        self.assertNotEqual(later["token"], prior["token"])
        self.assertEqual(later["facts"], prior["facts"])
        self.assertIsNone(ledger.claim())
        reopened.finish(later, {"state": "reviewed"})
        self.assertEqual([row["result"]["state"] for row in ledger.history(prior["id"])],
                         ["deferred", "reviewed"])
        with self.assertRaises(ValueError):
            ledger.retry(prior["id"], prior["version"], "finished with a decision")
        self.assertIsNone(reopened.claim())

    def test_expired_worker_does_not_abort_engineer_snapshot(self):
        now = [1_000]
        jobs = [{"job": "job-1", "source": "original-a"}, {"job": "job-2", "source": "original-b"}]

        def read_job(job):
            return [self.fact(job["source"], job["job"])]

        def compare(_case):
            now[0] += 601
            return {"state": "reviewed"}

        with patch.object(cross_read.time, "time", side_effect=lambda: now[0]):
            cases, issues = reading_flow(
                self.directory, "delivery-1", jobs, read_job, compare, lambda: now[0] == 1_000,
                lambda _revision, results, problems: (results, problems), workers=1,
            )
        self.assertEqual([case["state"] for case in cases], ["pending"])
        self.assertEqual([issue["kind"] for issue in issues], ["compare"])

    def test_ordinary_upload_initiates_only_after_both_addressed_source_jobs(self):
        root = Path(self.directory)
        files = {}
        originals = {"cabinet": "PMP-81   2 mounting clips", "packing": "PMP-81   3 mounting clips"}
        for ref, line in originals.items():
            path = root / ref
            path.write_text(line)
            files[ref] = path
        owners = {ref: hashlib.sha256(path.read_bytes()).hexdigest() for ref, path in files.items()}
        activity = []

        def profile(directory, revision, units, actual_owners, publish):
            jobs = [{"job": ref, "source": digest} for ref, digest in actual_owners.items()]

            def read_job(job):
                ref = job["job"]
                activity.append(("read", ref))
                observation = located_observation(
                    ["PMP-81", [0], "data", units[ref][0]], {0: units[ref][0]},
                )
                return [{**observation, "unit": ref, "job": ref, "source": job["source"],
                         "receipt": f"accepted/{ref}", "model": "reader-A"}]

            def compare(case):
                activity.append(("compare", case["id"]))
                self.assertEqual({fact["job"] for fact in case["facts"]}, set(originals))
                return {"state": "open"}

            return reading_flow(directory, revision, jobs, read_job, compare, lambda: True, publish, workers=1)

        quiet = lambda *_: self.fail("comparisons must originate in the separate reading jobs")
        cases = ordinary_upload(
            files=files, expected=owners, read=lambda *_: ({k: [v] for k, v in originals.items()}, owners),
            survey=quiet, screen=quiet, inspect=quiet, publish=lambda _revision, result, issues: (result, issues),
            folder=root / "workflow", readers=("reader-A", "reader-B"), reading_profile=profile,
        )
        result, issues = cases
        self.assertEqual(issues, [])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["state"], "open")
        self.assertEqual(activity[:2], [("read", "cabinet"), ("read", "packing")])
        self.assertEqual(activity[2:], [("compare", result[0]["id"])])

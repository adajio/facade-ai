"""Synthetic controls for primary-reading coverage under shared admission."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Event
import unittest
from unittest.mock import patch

from experiments.package_review import reading_flow
from experiments.package_review.package_reading import PackageReading
from experiments.package_review.research import digest


def read_result(job, observations=(), **fields):
    return {
        "state": "read",
        "receipt": f"synthetic/{job['job']}/{job['model']}",
        "observations": list(observations),
        **fields,
    }


class IntakeCoverageControls(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory()))
        self.origins = {
            "left": {
                "left:p1": ["K7 left bracket " + ". " * 550] * 16,
                "left:p2": ["Left cover sheet"],
            },
            "right": {"right:p1": ["K7 right bracket"], "right:p2": []},
            "cover": {"cover:p1": ["General index"]},
        }
        self.files = {name: self.root / name for name in self.origins}
        for name, path in self.files.items():
            path.write_text(name)
        self.expected = {
            name: hashlib.sha256(path.read_bytes()).hexdigest()
            for name, path in self.files.items()
        }
        self.units = {
            unit: lines for original in self.origins.values() for unit, lines in original.items()
        }
        self.owners = {
            unit: self.expected[name]
            for name, original in self.origins.items()
            for unit in original
        }
        self.run = self.root / "run"

    def upload(self, extract, compare, available=lambda: True, folder=None, reader=None,
               restore_source=None):
        options = {"restore_source": restore_source} if restore_source is not None else {}
        return PackageReading(
            reader=reader or (lambda *_: (self.units, self.owners)),
            models=("model-A", "model-B"),
            extract=extract,
            compare=compare,
            gateway_available=available,
            publish=lambda _, cases, issues: (cases, issues),
            workers=1,
            **options,
        ).upload(self.files, self.expected, folder or self.run)

    @staticmethod
    def observation(job, rows):
        if not rows or not rows[min(rows)].startswith("K7 "):
            return []
        return [{
            "label": "K7", "lines": [min(rows)], "role": "data",
            "text": rows[min(rows)].strip(),
            "receipt": f"synthetic/{job['job']}/{job['model']}",
        }]

    def test_budget_prefix_reaches_all_units_before_extra_windows_or_readers(self):
        events = []
        budget = len(self.units)

        def read(job, rows):
            events.append((job, set(rows)))
            return read_result(job, self.observation(job, rows))

        def compare(_):
            self.fail("a comparison attempted to spend the primary-reading budget")

        cases, issues = self.upload(read, compare, lambda: len(events) < budget)
        self.assertEqual(issues, [])
        self.assertEqual(len(events), budget)
        self.assertEqual({job["unit"] for job, _ in events}, set(self.units))
        self.assertEqual(len({job["source"] for job, _ in events[:3]}), 3)
        self.assertEqual([case["state"] for case in cases], ["pending"])
        work_path, = self.run.rglob("source-work.json")
        work = json.loads(work_path.read_bytes())
        self.assertEqual(sum(row["state"] == "read" for row in work), budget)
        self.assertGreater(sum(row["state"] == "pending" for row in work), budget)

        calls = []

        def resumed_comparison(case):
            self.assertEqual(len(events), len(work))
            calls.append(case["id"])
            return {"state": "consistent"}

        cases, issues = self.upload(read, resumed_comparison)
        self.assertEqual(issues, [])
        self.assertEqual([case["state"] for case in cases], ["consistent"])
        self.assertEqual(calls, [cases[0]["id"]])
        self.assertEqual(len({(job["job"], job["model"]) for job, _ in events}), len(work))
        for unit, lines in self.units.items():
            for model in ("model-A", "model-B"):
                windows = [rows for job, rows in events if (job["unit"], job["model"]) == (unit, model)]
                self.assertTrue(windows, (unit, model))
                self.assertEqual(Counter(i for rows in windows for i in rows), Counter(range(len(lines))))
        self.upload(lambda *_: self.fail("completed work was sent again"), compare)

    def test_exhausted_source_iterator_with_nonterminal_result_never_dispatches_comparison(self):
        outcomes = {
            "partial": lambda job: read_result(job, state="partial", reason="length"),
            "single_line_truncated": lambda job: read_result(job, finish_reason="length"),
            "deferred": lambda job: read_result(job, state="deferred", reason="gateway_denied"),
            "ambiguous_empty": lambda job: [],
            "unreceipted_empty": lambda job: {"state": "read", "observations": []},
            "unproven_terminal": lambda job: {"state": "unavailable", "reason": "missing decoder", "observations": []},
            "exception": lambda job: self.raise_read_failure(),
        }
        for name, fail in outcomes.items():
            with self.subTest(outcome=name):
                folder = self.root / name
                seen = Counter()
                comparison_calls = []
                obstructed = ("cover:p1", "model-B")

                def read(job, rows):
                    key = job["unit"], job["model"]
                    seen[key] += 1
                    if key == obstructed and seen[key] == 1:
                        return fail(job)
                    return read_result(job, self.observation(job, rows))

                def compare(case):
                    comparison_calls.append((case["id"], seen[obstructed]))
                    return {"state": "consistent"}

                cases, _ = self.upload(read, compare, folder=folder)
                self.assertEqual(comparison_calls, [])
                self.assertEqual([case["state"] for case in cases], ["pending"])
                state_path, = folder.rglob("reading-ledger.sqlite")
                with closing(sqlite3.connect(f"{state_path.as_uri()}?mode=ro", uri=True)) as state:
                    self.assertEqual(state.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)
                before = seen.copy()
                cases, issues = self.upload(read, compare, folder=folder)
                self.assertEqual(issues, [])
                self.assertEqual(seen - before, Counter({obstructed: 1}))
                self.assertEqual(comparison_calls, [(cases[0]["id"], 2)])
                self.assertEqual([case["state"] for case in cases], ["consistent"])

    @staticmethod
    def raise_read_failure():
        raise OSError("synthetic extraction failure")

    def test_confirmed_technical_unavailability_releases_gate_without_becoming_read(self):
        deferred_unit = "cover:p1"
        events = []

        def read(job, rows):
            events.append("source")
            if job["unit"] == deferred_unit:
                return read_result(job, state="unavailable", reason="unsupported_encryption")
            return read_result(job, self.observation(job, rows))

        def compare(_):
            events.append("comparison")
            return {"state": "consistent"}

        cases, issues = self.upload(read, compare)
        self.assertEqual(issues, [])
        self.assertEqual([case["state"] for case in cases], ["consistent"])
        work_path, = self.run.rglob("source-work.json")
        work = json.loads(work_path.read_bytes())
        failures = [item for item in work if item["unit"] == deferred_unit]
        self.assertEqual(len(failures), 2)
        self.assertEqual({row["state"] for row in failures}, {"unavailable"})
        self.assertEqual({row["reason"] for row in failures}, {"unsupported_encryption"})
        self.assertEqual(events, ["source"] * len(work) + ["comparison"])
        self.upload(lambda *_: self.fail("terminal outcomes were repeated"), compare)
        self.assertEqual(events, ["source"] * len(work) + ["comparison"])

    def test_deferred_retry_preserves_prior_partial_opening(self):
        comparisons = []
        cover = self.expected["cover"]

        def read(job, rows):
            if job["unit"] != "cover:p1" or result == "recover":
                return read_result(job, self.observation(job, rows))
            if job["model"] == "model-A":
                if result == "partial":
                    return read_result(job, state="partial", reason="response_format")
                if result == "exception":
                    self.raise_read_failure()
            return {"state": "deferred", "reason": "not sent", "observations": []}

        def compare(case):
            comparisons.append(case["id"])
            return {"state": "consistent"}

        for result in ("partial", "deferred", "exception"):
            with self.subTest(result=result):
                cases, _ = self.upload(read, compare)
                coverage_path, = self.run.rglob("coverage.json")
                coverage = json.loads(coverage_path.read_bytes())
                self.assertEqual(coverage["by_original"][cover]["opened"], 1)
                self.assertEqual(coverage["by_original"][cover]["fully_read"], 0)
                self.assertFalse(coverage["comparison_eligible"])
                self.assertEqual(comparisons, [])
                self.assertEqual([case["state"] for case in cases], ["pending"])

        result = "recover"
        cases, issues = self.upload(read, compare)
        self.assertEqual(issues, [])
        self.assertEqual(comparisons, [cases[0]["id"]])
        self.assertEqual([case["state"] for case in cases], ["consistent"])

    def test_shared_receipt_cannot_close_two_independent_empty_readings(self):
        events = []

        def read(job, rows):
            if job["unit"] == "cover:p1":
                return read_result(job, receipt="synthetic/one-delivery")
            return read_result(job, self.observation(job, rows))

        def compare(case):
            events.append(case["id"])
            return {"state": "consistent"}

        cases, _ = self.upload(read, compare)
        self.assertEqual(events, [])
        self.assertEqual([case["state"] for case in cases], ["pending"])
        work_path, = self.run.rglob("source-work.json")
        work = json.loads(work_path.read_bytes())
        self.assertEqual(
            Counter(row["state"] for row in work if row["unit"] == "cover:p1"),
            Counter({"read": 1, "deferred": 1}),
        )

        cases, issues = self.upload(
            lambda job, rows: read_result(job, self.observation(job, rows)), compare
        )
        self.assertEqual(issues, [])
        self.assertEqual(events, [cases[0]["id"]])

    def test_missing_original_remains_visible_and_blocks_comparisons(self):
        def reader(*_):
            units = {ref: rows for ref, rows in self.units.items() if ref != "cover:p1"}
            return units, {ref: self.owners[ref] for ref in units}

        calls = []

        def compare(case):
            calls.append(case["id"])
            return {"state": "consistent"}

        def read(job, rows):
            return read_result(job, self.observation(job, rows))

        cases, _ = self.upload(read, compare, reader=reader)
        self.assertEqual(calls, [])
        self.assertEqual([case["state"] for case in cases], ["pending"])
        coverage_path, = self.run.rglob("coverage.json")
        coverage = json.loads(coverage_path.read_bytes())
        self.assertEqual(coverage["originals_without_units"], [self.expected["cover"]])
        self.assertFalse(coverage["comparison_eligible"])

        cases, issues = self.upload(read, compare)
        self.assertEqual(issues, [])
        self.assertEqual(calls, [cases[0]["id"]])
        self.assertEqual([case["state"] for case in cases], ["consistent"])

    def test_previously_planned_unit_cannot_disappear_inside_present_original(self):
        target = "left:p2"
        seen = []
        comparisons = []

        def read(job, rows):
            seen.append(job["unit"])
            return read_result(job, self.observation(job, rows))

        def blocked(job, rows):
            if job["unit"] == target:
                return {"state": "deferred", "reason": "not sent", "observations": []}
            return read(job, rows)

        def missing_unit(*_):
            units = {ref: rows for ref, rows in self.units.items() if ref != target}
            return units, {ref: self.owners[ref] for ref in units}

        def compare(case):
            comparisons.append(case["id"])
            return {"state": "consistent"}

        self.upload(blocked, compare)
        before = seen.copy()
        self.assertEqual(comparisons, [])
        cases, _ = self.upload(read, compare, reader=missing_unit)
        self.assertEqual(seen, before)
        self.assertEqual(comparisons, [])
        self.assertEqual([case["state"] for case in cases], ["pending"])
        coverage_path, = self.run.rglob("coverage.json")
        coverage = json.loads(coverage_path.read_bytes())
        self.assertFalse(coverage["comparison_eligible"])
        self.assertEqual(coverage["originals_without_units"], [])
        self.assertEqual(coverage["model_windows"]["inventory_gap"], 2)
        work = json.loads(coverage_path.with_name("source-work.json").read_bytes())
        self.assertEqual([j["state"] for j in work if j["unit"] == target], ["inventory_gap"] * 2)

        cases, issues = self.upload(read, compare)
        self.assertEqual(issues, [])
        self.assertEqual(seen[len(before):], [target, target])
        self.assertEqual(comparisons, [cases[0]["id"]])
        self.assertEqual([case["state"] for case in cases], ["consistent"])

    def test_legacy_read_needs_confirmed_receipt_before_retry_or_comparison(self):
        run_without_gateway = lambda: False
        self.upload(lambda *_: self.fail("unexpected gateway work"),
                    lambda _: self.fail("unexpected comparison"), run_without_gateway)
        state_path, = self.run.rglob("reading-ledger.sqlite")
        plan = json.loads(state_path.with_name("source-plan.json").read_bytes())
        legacy_job = next(j for j in plan if (j["unit"], j["model"]) == ("cover:p1", "model-A"))
        revision = state_path.parent.name
        legacy_key = digest([revision, legacy_job["job"], legacy_job["model"]])
        with closing(sqlite3.connect(state_path)) as state, state:
            state.execute("DROP TABLE source_work")
            state.execute("CREATE TABLE source_work(rev TEXT,id TEXT,state TEXT,reason TEXT,PRIMARY KEY(rev,id))")
            state.execute("INSERT INTO source_work VALUES (?,?,'read','')", (revision, legacy_key))

        network_reads, recovered, compared = [], [], []

        def read(job, rows):
            network_reads.append((job["job"], job["model"]))
            return read_result(job, self.observation(job, rows))

        def restore(job, _):
            recovered.append(job)
            return read_result(job)

        def compare(case):
            compared.append(case["id"])
            return {"state": "consistent"}

        cases, issues = self.upload(read, compare, restore_source=lambda *_: None)
        self.assertEqual(issues, [])
        self.assertEqual(len(network_reads), len(plan) - 1)
        self.assertNotIn((legacy_job["job"], legacy_job["model"]), network_reads)
        self.assertEqual(compared, [])
        self.assertEqual([case["state"] for case in cases], ["pending"])
        work = json.loads(state_path.with_name("source-work.json").read_bytes())
        legacy_state, = [j["state"] for j in work if (j["job"], j["model"]) ==
                         (legacy_job["job"], legacy_job["model"])]
        self.assertEqual(legacy_state, "needs_receipt")

        cases, issues = self.upload(read, compare, restore_source=restore)
        self.assertEqual(issues, [])
        self.assertEqual(recovered, [legacy_job])
        self.assertEqual(len(network_reads), len(plan) - 1)
        self.assertEqual(compared, [cases[0]["id"]])
        self.assertEqual([case["state"] for case in cases], ["consistent"])

    def test_truncated_window_resumes_from_remaining_subrange(self):
        events = []
        target = []
        first_child_completed = []
        comparisons = []

        def read(job, rows):
            events.append(job)
            if target and job.get("parent_job") == target[0]["job"]:
                first_child_completed.append(job)
            if not target and job["unit"] == "left:p1" and len(rows) > 2:
                target.append(job)
                return read_result(job, self.observation(job, rows), finish_reason="length")
            return read_result(job, self.observation(job, rows))

        def compare(case):
            comparisons.append(case["id"])
            return {"state": "consistent"}

        cases, issues = self.upload(read, compare, lambda: not first_child_completed)
        self.assertEqual(issues, [])
        self.assertEqual(comparisons, [])
        self.assertEqual([case["state"] for case in cases], ["pending"])
        parent, = target
        child, = first_child_completed
        self.assertEqual(child["model"], parent["model"])
        self.assertTrue(set(child["lines"]) < set(parent["lines"]))
        work_path, = self.run.rglob("source-work.json")
        work = json.loads(work_path.read_bytes())
        self.assertEqual([row["state"] for row in work if (row["job"], row["model"]) ==
                          (parent["job"], parent["model"])], ["partial"])
        before = len(events)

        cases, issues = self.upload(read, compare)
        self.assertEqual(issues, [])
        self.assertEqual(comparisons, [cases[0]["id"]])
        self.assertEqual([case["state"] for case in cases], ["consistent"])
        remaining, = events[before:]
        self.assertEqual(remaining["parent_job"], parent["job"])
        self.assertEqual(remaining["model"], parent["model"])
        self.assertEqual(Counter(child["lines"] + remaining["lines"]), Counter(parent["lines"]))
        self.upload(lambda *_: self.fail("closed subranges were sent again"), compare)
        self.assertEqual(comparisons, [cases[0]["id"]])

    def test_running_primary_request_finishes_before_a_comparison_is_submitted(self):
        jobs = [{"job": key, "model": "A"} for key in ("left", "right", "last")]
        release = Event()
        late_worker = []
        compared_while_source_busy = []

        def read(job):
            key = job["job"]
            if key == "last":
                if not release.wait(timeout=5):
                    raise TimeoutError("test did not release the in-flight primary job")
                return read_result(job)
            return read_result(job, [{
                "source": key, "unit": key + ":1", "job": key, "model": job["model"],
                "receipt": key, "topic": "k7", "label": "K7",
                "role": "data", "text": "A synthetic bracket", "lines": [0],
            }])

        def compare(_):
            return {"state": "consistent"}

        class ObservedPool(ThreadPoolExecutor):
            def submit(self, fn, item):
                if fn is compare:
                    compared_while_source_busy.append(not late_worker or not late_worker[0].done())
                future = super().submit(fn, item)
                job = item[1] if isinstance(item, tuple) else item
                if job.get("job") == "last":
                    late_worker.append(future)
                return future

        def let_last_source_complete(active, **kwargs):
            if late_worker and set(active) == {late_worker[0]}:
                release.set()
            return wait(active, **kwargs)

        with (
            patch.object(reading_flow, "ThreadPoolExecutor", ObservedPool),
            patch.object(reading_flow, "wait", let_last_source_complete),
        ):
            cases, issues = reading_flow.reading_flow(
                self.run, "package", jobs, read, compare, lambda: True,
                lambda _, cases, issues: (cases, issues), workers=3,
            )
        self.assertEqual(compared_while_source_busy, [False])
        self.assertEqual(issues, [])
        self.assertEqual([case["state"] for case in cases], ["consistent"])

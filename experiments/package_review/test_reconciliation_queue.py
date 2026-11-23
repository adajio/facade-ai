"""Synthetic controls for source comparison work in a museum loan package."""

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

from experiments.package_review.fact_store import FactStore
from experiments.package_review.reconciliation_queue import ReconciliationQueue


SCOPE = {"scope": "museum/loan-418", "package_revision": "intake-2"}
REGISTER = "loan-register/rev-2#outbound"
TALLY = "packing-tally/rev-5#crate-C4"
REFERENCE_SIGNAL = {"kind": "shared_reference", "origin": "intake-index", "reference": "loan-418/crate-C4"}
COUNT_SIGNAL = {"kind": "candidate_difference", "origin": "reader-B", "reference": "reading-B/item-4",
                "detail": "The register and packing tally appear to count different numbers of mounts in crate C4."}


def discover(queue, **changes):
    return queue.discover(**{
        **SCOPE, "left": REGISTER, "right": TALLY, "reasons": [REFERENCE_SIGNAL],
        "readers": ["reader-A", "reader-B"], **changes,
    })


def addressed_readings():
    return [
        {"reader": reader, "unit": unit, "receipt": f"reading-{reader}/{index}",
         "location": location, "observed_mounts": mounts}
        for reader in ("reader-A", "reader-B")
        for index, (unit, location, mounts) in enumerate([
            (REGISTER, "Outbound, line 26, crate C4, Mount count", 11),
            (TALLY, "Sheet 2, crate C4, line 8, packed mounts", 14),
        ], 1)
    ]


class ReconciliationQueueTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "intake.sqlite"
        self.now = 1000

    def queue(self):
        return ReconciliationQueue(self.path, clock=lambda: self.now)

    def test_reversed_pair_and_repeated_signals_share_work_with_all_origins(self):
        with self.queue() as queue:
            initial = discover(queue)
            merged = discover(queue, left=TALLY, right=REGISTER, readers=["reader-B", "reader-A"],
                              reasons=[COUNT_SIGNAL, dict(reversed(tuple(REFERENCE_SIGNAL.items())))])
            self.assertEqual(merged["task_id"], initial["task_id"])
            self.assertEqual(merged["units"], sorted([REGISTER, TALLY]))
            self.assertEqual(merged["reasons"], [REFERENCE_SIGNAL, COUNT_SIGNAL])
            self.assertEqual(queue.list_tasks(**SCOPE), [merged])
            with self.assertRaisesRegex(ValueError, "assignment differs"):
                discover(queue, readers=["reader-A", "reader-C"])

    def test_missing_signal_or_same_unit_does_not_create_work(self):
        with self.queue() as queue:
            for changes in ({"reasons": []}, {"right": REGISTER}, {"readers": ["reader-A", "reader-A"]}):
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    discover(queue, **changes)
            self.assertEqual(queue.list_tasks(**SCOPE), [])

    def test_scopes_and_package_revisions_are_independent(self):
        with self.queue() as queue:
            active = discover(queue)
            other_scope = discover(queue, scope="museum/loan-419")
            next_revision = discover(queue, package_revision="intake-3")
            self.assertEqual(len({item["task_id"] for item in (active, other_scope, next_revision)}), 3)
            self.assertEqual(queue.list_tasks(**SCOPE), [active])

    def test_refuses_missing_reader_wrong_unit_and_reused_receipts(self):
        with self.queue() as queue:
            task_id = discover(queue)["task_id"]
            attempt_id = queue.assign(task_id, worker="comparison-worker")["attempt_id"]
            readings = addressed_readings()
            for evidence in (
                readings[:2],
                [*readings[:3], {**readings[3], "location": ""}],
                [*readings[:3], {**readings[3], "unit": "condition-report/rev-3"}],
                [*readings[:3], {**readings[3], "receipt": readings[1]["receipt"]}],
            ):
                with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                    queue.complete(task_id, attempt_id, outcome="counts_differ", evidence=evidence)
            self.assertEqual(queue.get(task_id)["status"], "assigned")

    def test_failure_survives_restart_and_retry_closes_with_independent_proof(self):
        readings = addressed_readings()
        reason = "Packing tally unavailable to reader-B during the first attempt"
        with self.queue() as queue:
            task_id = discover(queue, reasons=[REFERENCE_SIGNAL, COUNT_SIGNAL])["task_id"]
            first = queue.assign(task_id, worker="worker-before-restart")["attempt_id"]
            pending = queue.fail(task_id, first, reason=reason, evidence=readings[:2])
            self.assertEqual(pending["status"], "open")
            self.assertEqual(queue.fail(task_id, first, reason=reason, evidence=readings[:2]), pending)
        with self.queue() as queue:
            pending = queue.get(task_id)
            self.assertEqual(pending["status"], "open")
            self.assertEqual(pending["attempts"][0]["result"]["reason"], reason)
            self.assertCountEqual(pending["attempts"][0]["result"]["evidence"], readings[:2])
            second = queue.assign(task_id, worker="worker-after-restart")["attempt_id"]
            with self.assertRaisesRegex(ValueError, "no longer assigned"):
                queue.complete(task_id, first, outcome="counts_differ", evidence=readings)
            closed = queue.complete(task_id, second, outcome="counts_differ", evidence=readings)
            self.assertEqual(closed["status"], "closed")
            self.assertEqual([item["status"] for item in closed["attempts"]], ["failed", "closed"])
            self.assertEqual(closed["attempts"][-1]["result"]["outcome"], "counts_differ")
            self.assertCountEqual(closed["attempts"][-1]["result"]["evidence"], readings)
            self.assertEqual(queue.complete(task_id, second, outcome="counts_differ", evidence=readings[::-1]), closed)
            with self.assertRaisesRegex(ValueError, "no longer assigned"):
                queue.complete(task_id, second, outcome="counts_match", evidence=readings)
            self.assertEqual(discover(queue), closed)
            self.assertIsNone(queue.assign(task_id, worker="unneeded"))
        with self.queue() as queue:
            self.assertEqual(queue.get(task_id), closed)

    def test_expired_lease_can_be_reassigned_but_the_old_worker_cannot_write(self):
        with self.queue() as queue:
            task_id = discover(queue)["task_id"]
            first = queue.assign(task_id, worker="stopped-worker", lease_seconds=10)
        self.now += 10
        with self.queue() as queue:
            self.assertEqual(queue.get(task_id)["status"], "open")
            with self.assertRaisesRegex(ValueError, "no longer assigned"):
                queue.fail(task_id, first["attempt_id"], reason="late report")
            second = queue.assign(task_id, worker="recovery-worker")
            self.assertNotEqual(second["attempt_id"], first["attempt_id"])
            with self.assertRaisesRegex(ValueError, "no longer assigned"):
                queue.complete(task_id, first["attempt_id"], outcome="counts_differ", evidence=addressed_readings())
            self.assertEqual([item["status"] for item in queue.get(task_id)["attempts"]], ["expired", "assigned"])

    def test_new_reasons_are_retained_and_require_a_current_assignment(self):
        with self.queue() as queue:
            task_id = discover(queue)["task_id"]
            first = queue.assign(task_id, worker="worker")["attempt_id"]
            discover(queue, reasons=[COUNT_SIGNAL])
            with self.assertRaisesRegex(ValueError, "new reasons arrived"):
                queue.complete(task_id, first, outcome="counts_differ", evidence=addressed_readings())
            queue.fail(task_id, first, reason="A new signal arrived during the comparison")
            second = queue.assign(task_id, worker="worker")["attempt_id"]
            self.assertEqual(queue.complete(task_id, second, outcome="counts_differ",
                                            evidence=addressed_readings())["status"], "closed")
            reopened = discover(queue, reasons=[{**COUNT_SIGNAL, "origin": "reader-A", "reference": "reading-A/item-6"}])
            self.assertEqual(reopened["status"], "open")
            self.assertEqual(reopened["attempts"][-1]["status"], "closed")
            self.assertEqual(len(reopened["reasons"]), 3)

    def test_only_one_concurrent_worker_gets_the_task(self):
        with self.queue() as queue:
            task_id = discover(queue)["task_id"]
        barrier = Barrier(2, timeout=5)

        def assign(worker):
            with self.queue() as queue:
                barrier.wait()
                return queue.assign(task_id, worker=worker)

        with ThreadPoolExecutor(max_workers=2) as pool:
            assigned = [item for item in pool.map(assign, ["worker-one", "worker-two"]) if item]
        self.assertEqual(len(assigned), 1)
        with self.queue() as queue:
            self.assertEqual(queue.get(task_id)["attempts"], assigned)

    def test_queue_and_existing_fact_store_can_share_a_database(self):
        observation = {"observation_id": "obs-1", "fact_id": "register-count", "scope": SCOPE["scope"],
                       "package_revision": SCOPE["package_revision"], "origin": "reader-A",
                       "statement": "The outgoing loan register lists 11 mounts for crate C4.",
                       "sources": [{"source_id": REGISTER, "source_revision": "2", "locator": "line 26",
                                    "receipt": "reader-A/register"}]}
        with FactStore(self.path) as store:
            self.assertEqual(store.record_observation(observation)["status"], "stored")
        with self.queue() as queue:
            discover(queue)
        with FactStore(self.path) as store:
            self.assertEqual(store.record_observation(observation)["status"], "duplicate")
            self.assertEqual(len(store.history()), 1)

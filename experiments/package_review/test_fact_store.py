"""Synthetic regressions for the package experiment's durable ledger."""

import tempfile
import unittest
from pathlib import Path

from experiments.package_review.fact_store import FactStore


def source(**changes):
    return {"source_id": "drawing", "source_revision": "sha256:synthetic-r1", "locator": "p2:row4",
            "receipt": "session-A:tool-3", **changes}


def observation(**changes):
    return {"observation_id": "obs-1", "fact_id": "width-A", "package_revision": "pkg-r1",
            "statement": "Ширина вставки А составляет 900 мм.", "scope": "вставка А", "origin": "A",
            "sources": [source()], **changes}


def review(**changes):
    return {"review_id": "rev-1", "observation_id": "obs-1", "reviewer": "B", "verdict": "confirmed",
            "rationale": "В ячейке строки А под заголовком ширины стоят 900 мм.",
            "sources": [source(receipt="session-B:tool-2")], **changes}


def recommendation(**changes):
    return {"recommendation_id": "rec-1", "package_revision": "pkg-r1", "text": "Уточните применяемую вставку.",
            "basis_observation_ids": ["obs-1"], **changes}


def decision(**changes):
    return {"decision_id": "dec-1", "package_revision": "pkg-r1", "engineer": "engineer-1",
            "recommendation_ids": ["rec-1"], "rationale": "Подтверждён объём запроса.", **changes}


class FactStoreTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "ledger.sqlite"
        self.store = FactStore(self.path)
        self.addCleanup(self.store.close)

    def test_confirmed_facts_survive_reopen_and_truncated_summary(self):
        for index in range(1, 4):
            observation_id = f"obs-{index}"
            self.assertEqual(self.store.record_observation(observation(observation_id=observation_id,
                                                                      fact_id=f"fact-{index}"))["status"], "stored")
            self.assertEqual(self.store.record_review(review(observation_id=observation_id,
                                                            review_id=f"rev-{index}"))["status"], "stored")
        self.store.record_letter_recommendation(recommendation())
        with FactStore(self.path) as reader:
            exported = reader.export_engineer("pkg-r1", summary="Видна только первая строка…")
        self.assertEqual([fact["observation_id"] for fact in exported["confirmed_facts"]], ["obs-1", "obs-2", "obs-3"])
        first = exported["confirmed_facts"][0]
        self.assertEqual(first["sources"], observation()["sources"])
        self.assertEqual(first["reviews"], [review()])
        self.assertEqual(exported["letter_recommendations"][0]["approval"], "unapproved")
        self.assertEqual(exported["approved_letter"], {"status": "awaiting_engineer", "decision": None, "items": []})

    def test_idempotent_replay_and_conflicting_id_quarantine(self):
        store = self.store
        self.assertEqual(store.record_observation(observation())["status"], "stored")
        with FactStore(self.path) as another_writer:
            self.assertEqual(another_writer.record_observation(dict(reversed(tuple(observation().items()))))["status"], "duplicate")
            for _ in range(2):
                self.assertEqual(another_writer.record_observation(observation(statement="Другая ширина."))["status"], "invalid")
        self.assertEqual(len(store.history()), 1)
        self.assertEqual(len(store.invalid_records("pkg-r1")), 1)
        self.assertEqual(store.export_engineer("pkg-r1")["open_facts"][0]["statement"], observation()["statement"])

    def test_observations_need_review_and_every_claimed_place_must_match(self):
        store = self.store
        store.record_observation(observation(sources=[source(), source(locator="p3:row1")]))
        self.assertEqual(store.export_engineer("pkg-r1")["open_facts"][0]["status"], "unresolved")
        for invalid in (review(reviewer=" A "), review(rationale=" "), review(),
                        review(sources=[source(), source(locator="p3:row1", source_revision="wrong")])):
            self.assertEqual(store.record_review(invalid)["status"], "invalid")
        both_places = review(sources=[source(receipt="check-1"), source(locator="p3:row1", receipt="check-2")])
        self.assertEqual(store.record_review(both_places)["status"], "stored")
        self.assertEqual(len(store.export_engineer("pkg-r1")["confirmed_facts"]), 1)

    def test_incomplete_and_invalid_records_have_separate_destinations(self):
        store = self.store
        store.record_observation(observation(sources=[]))
        self.assertEqual(store.record_observation(observation(observation_id="bad", scope=None))["status"], "invalid")
        self.assertEqual(store.record_review(review())["status"], "invalid")
        self.assertEqual(store.record_observation({"observation_id": "orphan"})["status"], "invalid")
        exported = store.export_engineer("pkg-r1")
        self.assertEqual([fact["status"] for fact in exported["open_facts"]], ["incomplete"])
        self.assertEqual(len(exported["invalid_records"]), 2)
        self.assertEqual(len(store.invalid_records()), 3)
        self.assertEqual(store.export_engineer("pkg-r2")["invalid_records"], [])

    def test_competing_verdicts_and_review_correction(self):
        store = self.store
        store.record_observation(observation())
        store.record_review(review())
        store.record_review(review(review_id="rev-2", reviewer="C", verdict="rejected"))
        first = store.export_engineer("pkg-r1")["open_facts"][0]
        self.assertEqual(first["status"], "disputed")
        self.assertEqual(len(first["reviews"]), 2)
        changed = review(review_id="rev-3", reviewer="C", verdict="confirmed", supersedes="rev-2")
        self.assertEqual(store.record_review(changed)["status"], "stored")
        current = store.export_engineer("pkg-r1")["confirmed_facts"][0]
        self.assertEqual([r["review_id"] for r in current["reviews"]], ["rev-1", "rev-3"])
        self.assertEqual(len(store.history("pkg-r1")), 4)

    def test_corrections_are_explicit_and_old_reviews_do_not_confirm_new_text(self):
        store = self.store
        store.record_observation(observation())
        store.record_review(review())
        changed = observation(observation_id="obs-2", statement="Ширина 850 мм.", supersedes="obs-1")
        self.assertEqual(store.record_observation({**changed, "supersedes": None})["status"], "invalid")
        self.assertEqual(store.record_observation(changed)["status"], "stored")
        self.assertEqual(store.record_observation({**changed, "observation_id": "fork"})["status"], "invalid")
        exported = store.export_engineer("pkg-r1")
        self.assertEqual(exported["confirmed_facts"], [])
        self.assertEqual([f["observation_id"] for f in exported["open_facts"]], ["obs-2"])
        self.assertEqual(store.history("pkg-r1")[0]["record"]["observation_id"], "obs-1")

    def test_approval_requires_current_basis_and_never_revives_after_revision(self):
        store = self.store
        store.record_observation(observation(finding="confirmed_conflict", statement="В спецификациях разные размеры А."))
        store.record_letter_recommendation(recommendation(basis_kind="confirmed_conflict"))
        self.assertEqual(store.record_engineer_decision(decision())["status"], "invalid")
        store.record_review(review())
        self.assertEqual(store.record_engineer_decision(decision())["status"], "stored")
        approval = store.export_engineer("pkg-r1")["approved_letter"]
        self.assertEqual(approval["items"][0]["approval"], "approved")
        self.assertEqual(store.export_engineer("pkg-r2")["approved_letter"]["items"], [])
        store.record_review(review(review_id="rev-2", supersedes="rev-1", verdict="disputed"))
        self.assertEqual(store.export_engineer("pkg-r1")["approved_letter"]["status"], "review_required")
        store.record_review(review(review_id="rev-3", supersedes="rev-2"))
        self.assertEqual(len(store.export_engineer("pkg-r1")["confirmed_facts"]), 1)
        self.assertEqual(store.export_engineer("pkg-r1")["approved_letter"]["items"], [])
        self.assertEqual(store.record_engineer_decision(decision(decision_id="dec-2", supersedes="dec-1",
                                                                 recommendation_ids=[]))["status"], "stored")
        self.assertEqual(store.export_engineer("pkg-r1")["approved_letter"]["status"], "closed_without_letter")

    def test_confirmed_observation_is_not_automatically_an_external_basis(self):
        store = self.store
        store.record_observation(observation())
        store.record_review(review())
        store.record_letter_recommendation(recommendation())
        store.record_letter_recommendation(recommendation(recommendation_id="rec-2", basis_kind="confirmed_conflict"))
        self.assertEqual(store.record_engineer_decision(decision(recommendation_ids=["rec-2"]))["status"], "invalid")
        self.assertEqual(store.record_engineer_decision(decision())["status"], "invalid")
        self.assertEqual([row["eligible_for_review"] for row in store.export_engineer("pkg-r1")["letter_recommendations"]],
                         [False, False])
        suspected = observation(observation_id="missing", fact_id="missing-parts", finding="confirmed_shortage")
        self.assertEqual(store.record_observation(suspected)["status"], "invalid")
        self.assertEqual(store.record_observation({**suspected, "gap_basis": "explicit_non_delivery"})["status"], "stored")

    def test_derived_observation_keeps_parent_and_has_separate_proof(self):
        store = self.store
        store.record_observation(observation())
        store.record_review(review())
        atom = observation(observation_id="atom-1", fact_id="separate-width", derived_from="obs-1")
        self.assertEqual(store.record_observation({**atom, "package_revision": "pkg-r2"})["status"], "invalid")
        self.assertEqual(store.record_observation(atom)["status"], "stored")
        snapshot = store.export_engineer("pkg-r1")
        self.assertEqual(snapshot["open_facts"][0]["derived_from"], "obs-1")
        self.assertEqual(snapshot["open_facts"][0]["reviews"], [])
        self.assertEqual(snapshot["confirmed_facts"][0]["observation_id"], "obs-1")


if __name__ == "__main__":
    unittest.main()

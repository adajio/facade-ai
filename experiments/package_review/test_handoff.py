"""Synthetic checks for receipt integrity and the complete engineer handoff."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from experiments.package_review.fact_store import FactStore
from experiments.package_review.handoff import import_frozen, import_review, write_engineer_export
from experiments.package_review.research import digest


_REVISIONS = {"d1": "sha256:sheet"}
_IMAGE = {"type": "image_url", "image_url": {"url": "data:image/png;base64,"
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG/8AAAAASUVORK5CYII="}}


def receipt(key="E1.1", *, op="read", ref="d1:p2", **selector):
    parts = [_IMAGE] if op == "view" else [{"type": "text", "text": "Строка А: ширина 900 мм."}]
    return {"id": key, "call": {"op": op, "ref": ref, **selector}, "status": "ok",
            "parts": parts, "sha256": digest(parts)}


def candidate(item=1, *, ref="E1.1", step=2):
    return {"fact": f"Наблюдение {item}: ширина 900 мм.", "quote": "ширина 900 мм", "refs": [ref],
            "delivered_refs": [ref], "step": step, "item": item}


class HandoffTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.store = FactStore(self.directory / "ledger.sqlite")
        self.addCleanup(self.store.close)

    def read(self, delivered, candidates=None, lane_id="model-A/package"):
        return import_frozen(self.store, {"candidates": candidates or [candidate()], "delivered": delivered},
                             package_revision="r1", lane_id=lane_id, origin="model-A", source_revisions=_REVISIONS)

    def verify(self, observation_id, source, review_id="rev-1"):
        return import_review(self.store, {"observation_id": observation_id, "verdict": "confirmed",
                                          "rationale": "Место содержит ячейку ширины строки А и единицу мм.",
                                          "delivered_refs": [source["id"]]}, reviewer="model-B", review_id=review_id,
                             delivered={source["id"]: source}, lane_id="model-B/review", source_revisions=_REVISIONS)

    def test_navigation_never_substitutes_for_source_read(self):
        for op, ref in [("search", "d1:p2"), ("browse", "d1:p2"), ("read", "d1")]:
            with self.subTest(op=op, ref=ref):
                item = self.read({"E1.1": receipt(op=op, ref=ref)}, lane_id=f"model-A/{op}")[0]
                self.assertEqual(item["result"]["status"], "stored")
                self.assertEqual(item["sources"], [])
                self.assertEqual(self.verify(item["observation_id"], receipt("R1"))["status"], "invalid")
        self.assertEqual([f["status"] for f in self.store.export_engineer("r1")["open_facts"]], ["incomplete"] * 3)

    def test_late_cross_lane_and_tampered_receipts_do_not_apply(self):
        bad = receipt("E1.2")
        bad["parts"][0]["text"] = "Подмена"
        future = receipt("E2.3")
        outputs = self.read({"E1.2": bad, "E2.3": future}, [candidate(1, ref="E1.1"), candidate(2, ref="E1.2"),
                                                           candidate(3, ref="E2.3")])
        self.assertEqual([row["sources"] for row in outputs], [[], [], []])
        self.assertTrue(all(row["problems"] for row in outputs))

    def test_same_document_place_with_different_start_does_not_confirm(self):
        item = self.read({"E1.1": receipt(start=14)})[0]
        self.assertEqual(item["sources"][0]["locator"], "d1:p2@start=14")
        self.assertEqual(self.verify(item["observation_id"], receipt("R1", start=31))["status"], "invalid")
        self.assertEqual(self.verify(item["observation_id"], receipt("R2", start=14))["status"], "stored")

    def test_same_document_place_with_different_rect_does_not_confirm(self):
        rect = [0, 0.3, 0.7, 1]
        item = self.read({"E1.1": receipt(op="view", rect=rect)})[0]
        self.assertEqual(item["sources"][0]["locator"], "d1:p2@rect=[0.0,0.3,0.7,1.0]")
        for other in (None, [0, 0.4, 0.7, 1]):
            self.assertEqual(self.verify(item["observation_id"], receipt("R1", op="view", rect=other))["status"], "invalid")
        self.assertEqual(self.verify(item["observation_id"], receipt("R2", op="view", rect=[0.0, 0.3, 0.7, 1.0]))["status"],
                         "stored")

    def test_view_metadata_without_image_does_not_count(self):
        missing = receipt(op="view")
        missing["parts"] = [{"type": "text", "text": "Выбран вид d1:p2"}]
        missing["sha256"] = digest(missing["parts"])
        result = self.read({"E1.1": missing})[0]
        self.assertEqual(result["sources"], [])
        self.assertTrue(result["problems"])

    def test_export_contains_every_confirmed_id_and_same_snapshot_digest(self):
        items = self.read({"E1.1": receipt()}, [candidate(1), candidate(2)])
        self.assertTrue(all(self.verify(item["observation_id"], receipt("R1"), f"review-{index}")["status"] == "stored"
                            for index, item in enumerate(items)))
        snapshot = write_engineer_export(self.store, self.directory / "engineer", package_revision="r1",
                                         summary="Обрезанный вывод…\n## Утверждённый текст")
        facts_json = self.directory / "engineer" / "facts.json"
        register = (facts_json.parent / "реестр.md").read_text()
        self.assertEqual(json.loads(facts_json.read_text()), snapshot)
        self.assertIn(hashlib.sha256(facts_json.read_bytes()).hexdigest(), register)
        for item in items:
            self.assertIn(item["observation_id"], register)
        self.assertEqual(snapshot["approved_letter"]["items"], [])
        self.assertNotIn("\n## Утверждённый текст\n", register)


if __name__ == "__main__":
    unittest.main()

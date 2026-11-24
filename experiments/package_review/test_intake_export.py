from tempfile import TemporaryDirectory
from pathlib import Path
import unittest
from experiments.package_review.intake_export import export_intake, export_reading_inventory


class ExportTest(unittest.TestCase):
    def test_similar_names_allow_inspection_but_do_not_confirm_a_conflict(self):
        samples = [{"term": "C8", "revision": rev, "unit": src, "reader": "A",
                    "lines": [2], "receipt": src, "reading": "4"} for rev,src in
                   [("r","x"),("r","y"),("old","x")]]
        with TemporaryDirectory() as folder:
            result = export_reading_inventory(Path(folder), "r", samples)
            g = result["groups"][0]
            self.assertEqual(set(g["by_unit"]), {"x","y"})
            self.assertEqual(g["applicability"], "requires_review")
            self.assertEqual(result["unassigned"], [])
            self.assertEqual(result["foreign_count"], 1)
            fact = {"id":"f", "state":"open", "finding":"confirmed_conflict"}
            snapshot = export_intake(Path(folder), [], [fact], [{"basis":["f"],"kind":"confirmed_conflict"}], revision="r")
            self.assertEqual(snapshot["draft_proposals"], [])
            self.assertEqual(snapshot["approved_items"], [])

    def test_challenged_context_withdraws_derived_question_without_rewriting_source(self):
        from experiments.package_review.intake_export import apply_source_challenges
        from experiments.package_review.research import digest
        fact = {"id":"x","text":"supply received","state":"verified"}
        snapshot = {"package_revision":"p", "observations":[fact],
                    "draft_proposals":[{"basis":["x"]}],"approved_items":[]}
        challenge = {"observation_id":"x","statement_digest":digest(fact["text"]),"revision":"p",
                     "reason":"parent heading describes an earlier request", "source_receipts":["p/list#heading"]}
        changed = apply_source_challenges(snapshot,[challenge])
        self.assertEqual(changed["draft_proposals"], [])
        self.assertEqual(changed["observations"][0]["state"], "open")
        self.assertEqual(fact["state"], "verified")
        with self.assertRaises(ValueError):
            apply_source_challenges(snapshot,[{**challenge,"revision":"other"}])

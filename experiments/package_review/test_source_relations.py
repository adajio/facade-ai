import unittest
from source_relations import source_signals, asymmetric_families


class SignalsTest(unittest.TestCase):
    def test_equipment_inventory_and_new_revision_reordered(self):
        units={"manifest":["PX7 motor 4","PX8 valve 6","PX9 rotor 2"],
               "service":["PX9 rotor 2","PX7 motor 1","PX7.2 motor 3","PX8 valve 6"],
               "memo":["lunch tomorrow at noon"]}
        owners={u:u for u in units}
        groups=source_signals(units,owners)
        self.assertEqual(len(groups),1)
        self.assertEqual(set(groups[0][0]["aligned_labels"]),{"px7","px8","px9"})
        self.assertEqual(asymmetric_families(units["manifest"],units["service"])[0]["family"],"px7")

    def test_single_shared_label_and_original_alias_do_not_route(self):
        a=["AX2 meeting","AX3 planning","AX4 follow-up"]
        self.assertEqual(source_signals({"A":a,"B":a,"C":["AX2 unrelated"]},{"A":"same","B":"same","C":"other"}),[])

    def test_narrative_sources_can_match_without_identifiers(self):
        texts=["Quarterly customer counts include licensed corporate subscribers only",
               "Pending renewal orders remain outside consolidated reported revenue"]
        self.assertTrue(source_signals({"x":texts,"y":list(reversed(texts))},{"x":"one","y":"two"}))

    def test_no_structural_overlap_remains_visible(self):
        from source_relations import unexamined_pairs
        units = {"x": ["Old instrument"], "y": ["Item slated for repair"], "z": []}
        owners = {"x": "a", "y": "b", "z": "a"}
        self.assertEqual(unexamined_pairs(units, owners, []), [
            {"originals": ["a", "b"], "units": [["x", "z"], ["y"]],
             "state": "requires_semantic_survey"}])

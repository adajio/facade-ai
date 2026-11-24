import unittest

from assessment_prefix import recover_reading


class PrefixTest(unittest.TestCase):
    def test_complete_items_survive_half_written_entry(self):
        raw = ('{"decision":"compared","sources":[{"ref":"a","lines":[0],"reading":"} quoted"},'
               '{"ref":"b","lines":[1],"reading":"b"}],"entries":[{"ref":"b","lines":[1],'
               '"label":"B9","value":"2"},{"ref":"a","label":"half')
        result = recover_reading(raw, "length", {"a": {0}, "b": {1}})
        self.assertTrue(result["comparison_requested"])
        self.assertFalse(result["complete"])
        self.assertEqual([r["label"] for r in result["entries"]], ["B9"])
        self.assertEqual(recover_reading(raw, "stop", {})["sources"], [])

    def test_invented_locations_and_nested_verdict_are_excluded(self):
        raw = ('{"note":{"decision":"compared"},"sources":[{"ref":"a","lines":[true],'
               '"reading":"no"},{"ref":"b","lines":[7],"reading":"out of excerpt"}],"end":')
        result = recover_reading(raw, "length", {"a": {1}, "b": {2}})
        self.assertFalse(result["comparison_requested"])
        self.assertEqual(result["sources"], [])

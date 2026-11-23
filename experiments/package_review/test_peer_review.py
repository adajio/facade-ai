import unittest
from peer_review import compact_input, read_verdicts


class CompactReviewTest(unittest.TestCase):
    def test_missing_conflicting_and_promise_are_not_confirmation(self):
        items = [{"observation_id": i, "statement": i, "refs": ["V1"]} for i in ["a", "b", "c"]]
        mat = {"V1":{"status":"ok","call":{"op":"read","ref":"d1:p1"},"parts":[{"type":"text","text":"values"}]}}
        self.assertEqual(compact_input(items, mat)[-1]["text"], "values")
        verdicts, pending = read_verdicts(items, '1 C: совпадает\n2 C: совпадает\n2 U: значения нет\nсверю позже')
        self.assertEqual([row["observation_id"] for row in verdicts], ["a"])
        self.assertEqual(pending, ["b","c"])
        with self.assertRaises(ValueError):
            compact_input(items, {})

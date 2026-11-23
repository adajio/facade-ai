import unittest
from schedule_rows import compare_rows, validate_row, windows


class ScheduleRowsTest(unittest.TestCase):
    def test_window_edges_and_literals(self):
        chunks = list(windows(9, width=3, overlap=2))
        self.assertEqual([i for w in chunks for i in range(w["start"], w["end"])], list(range(9)))
        lines = {2: "код А6*", 3: "Количество 3"}
        item = {"mark":"А6*", "anchor":2, "lines":[3], "qty":3, "group":"А6"}
        self.assertIsNone(validate_row(item, source="left", lines=lines, window=chunks[1])[1])
        for change in ({"mark":"А6"}, {"mark":"A6*"}, {"qty":4}, {"lines":[8]}):
            self.assertIsNotNone(validate_row({**item, **change}, source="left", lines=lines, window=chunks[1])[1])

    def test_same_total_different_variants_overlap_and_disagreement(self):
        old = {"source":"l", "anchor":1, "mark":"Z", "qty":7}
        one = {**old, "source":"r", "qty":3}
        two = {**one, "anchor":4, "mark":"Z*", "qty":4}
        result = compare_rows([old], [one, one, two])
        self.assertTrue(result["equal_subtotals"])
        self.assertFalse(result["same_variant_counts"])
        self.assertIsNone(compare_rows([old], [one,{**one,"qty":1}])["equal_subtotals"])
        self.assertIsNone(compare_rows([], [one])["same_variant_counts"])

    def test_column_signals_keep_repeated_base_and_mirror_separate(self):
        from schedule_rows import unaccounted_marks
        lines = ["    Z9  7", "    Z9.1  4", "    Z9.1*  2", "                D7 ref"]
        rows = [{"anchor":1, "mark":"Z9.1"}]
        self.assertEqual([a["label"] for a in unaccounted_marks(lines, rows)], ["Z9","Z9.1*"])

    def test_extra_commentary_does_not_discard_valid_siblings(self):
        from schedule_rows import decode_rows
        self.assertEqual(decode_rows('{"rows":[]}\nПояснение'), {"rows":[]})
        self.assertEqual(decode_rows('Сверю позже'), None)

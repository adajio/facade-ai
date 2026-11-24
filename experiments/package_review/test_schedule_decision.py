import unittest
from schedule_decision import compare_readers


class DecisionTest(unittest.TestCase):
    def test_agreement_requires_same_rows_and_valid_arithmetic(self):
        def answer(qty, total=7):
            return {"sources":[{"ref":"a","rows":[{"mark":"Z","anchor":4,"qty":7}],"total":7},
                               {"ref":"b","rows":[{"mark":"Z","anchor":3,"qty":qty},
                                                  {"mark":"Z*","anchor":6,"qty":7-qty}],"total":total}]}
        self.assertEqual(compare_readers(answer(2), answer(2), ["a","b"]), "counts_agree")
        self.assertEqual(compare_readers(answer(2), answer(3), ["a","b"]), "disputed_counts")
        self.assertEqual(compare_readers(answer(2,6), answer(2), ["a","b"]), "needs_source_review")
        self.assertEqual(compare_readers(answer(2), answer(2), ["a","b","c"]), "needs_source_review")

    def test_suggested_anchor_does_not_accept_a_neighbouring_variant(self):
        from schedule_decision import locate_mark
        lines = ["S7", "12", "S7.1*", "S7.1", "2"]
        self.assertEqual(locate_mark("S7.1", 2, lines), {"submitted":2,"line":3,"status":"suggested"})
        self.assertEqual(locate_mark("S7.1*", 2, lines)["status"], "exact")
        self.assertEqual(locate_mark("S7", 2, ["S7","S7","total"])["status"], "ambiguous")

    def test_selected_graphic_source_does_not_erase_valid_table_comparison(self):
        from schedule_decision import numeric_comparison
        def sheet(ref):
            return {"ref":ref,"rows":[{"mark":"R","anchor":5,"qty":2}],"total":2}
        answer={"sources":[sheet("a"), sheet("b"), {"ref":"drawing","rows":[],"total":None}]}
        self.assertEqual(len(numeric_comparison(answer, ["a","b"], ["drawing"])), 2)
        answer["sources"][-1]=sheet("drawing")
        self.assertEqual(numeric_comparison(answer, ["a","b"], ["drawing"]), {})

    def test_competing_dimensions_survive_matching_quantities(self):
        from schedule_decision import dimension_disputes
        def ans(size):
            return {"sources":[{"ref":"sheet","rows":[{"mark":"Z*","qty":4,"size":size}]}]}
        self.assertTrue(dimension_disputes([ans("2000×500 мм"),ans("3000х500")]))
        self.assertFalse(dimension_disputes([ans("2000×500"),ans("2000 x 500")]))

    def test_confirmed_label_cannot_override_a_different_measurement(self):
        from schedule_decision import review_measured_field
        claim={"source_revision":"rev","mark":"Z*","location":"p:row","field":"height_width","unit":"mm",
               "value":[1500,600],"receipt":"one"}
        review={**claim, "verdict":"confirmed", "receipt":"two", "observed_value":[4000,800]}
        self.assertEqual(review_measured_field(claim, review), "disputed")
        self.assertEqual(review_measured_field(claim, {**review,"observed_value":None}), "unresolved")
        self.assertEqual(review_measured_field(claim, {**review,"observed_value":[1500,600]}), "confirmed")

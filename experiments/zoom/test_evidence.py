import unittest

from evidence import evaluate_evidence


def observation(**overrides):
    return {"status": "found", "mark": "F-17", "value": 65, "unit": "мм", "code": "A30614", **overrides}


class EvidenceTest(unittest.TestCase):
    def test_ascii_catalog_supports_literal_code(self):
        result = evaluate_evidence(observation(), alphabet="ascii_hex", source_status="verified")

        self.assertEqual(result["status"], "supported")
        self.assertEqual(result["applied"], {"mark": "F-17", "value": 65, "unit": "мм", "code": "A30614"})
        self.assertFalse(result["absence_supported"])

    def test_unknown_alphabet_keeps_visually_ambiguous_text_and_applies_independent_measurement(self):
        for code in ("A30614", "\u041030614"):
            with self.subTest(code=code):
                result = evaluate_evidence(observation(code=code), alphabet=None, source_status="verified")

                self.assertEqual(result["status"], "partial")
                self.assertEqual(result["code_raw"], code)
                self.assertEqual(result["code_status"], "ambiguous")
                self.assertEqual(result["ambiguous_glyphs"], [{"index": 0, "latin": "A", "cyrillic": "А"}])
                self.assertEqual(result["applied"], {"mark": "F-17", "value": 65, "unit": "мм", "code": None})

    def test_missing_catalog_does_not_make_digits_visually_ambiguous(self):
        result = evaluate_evidence(observation(code="123456"), alphabet=None, source_status="verified")

        self.assertEqual(result["code_raw"], "123456")
        self.assertEqual(result["code_status"], "unconfirmed_alphabet")
        self.assertEqual(result["reason"], "code_alphabet_unknown")
        self.assertIsNone(result["applied"]["code"])

    def test_ascii_catalog_rejects_cyrillic_and_extra_whitespace_without_rewriting(self):
        for code in ("\u041030614", "A30614 ", "a30614"):
            with self.subTest(code=code):
                result = evaluate_evidence(observation(code=code), alphabet="ascii_hex", source_status="verified")

                self.assertEqual(result["code_raw"], code)
                self.assertEqual(result["code_status"], "invalid")
                self.assertIsNone(result["applied"]["code"])

    def test_invalid_value_or_unit_does_not_apply_measurement(self):
        for override in ({"unit": ["мм"]}, {"unit": "mm"}, {"value": True}, {"value": "65"}):
            with self.subTest(override=override):
                result = evaluate_evidence(observation(**override), alphabet="ascii_hex", source_status="verified")

                self.assertEqual(result["reason"], "invalid_measurement")
                self.assertIsNone(result["applied"])

    def test_substitution_cannot_apply_fact_or_absence_even_with_categorical_answer(self):
        for status in ("found", "absent", "mismatch"):
            with self.subTest(status=status):
                result = evaluate_evidence(
                    observation(status=status, note="F-17 definitely absent"),
                    alphabet="ascii_hex",
                    source_status="mismatch",
                )

                self.assertEqual(result["status"], "needs_evidence")
                self.assertEqual(result["reason"], "source_mismatch")
                self.assertEqual(result["code_raw"], "A30614")
                self.assertIsNone(result["applied"])
                self.assertFalse(result["absence_supported"])

    def test_a_verified_crop_cannot_prove_absence_from_the_sheet(self):
        result = evaluate_evidence(observation(status="absent"), alphabet="ascii_hex", source_status="verified")

        self.assertEqual(result["reason"], "absence_unsupported")
        self.assertFalse(result["absence_supported"])
        self.assertIsNone(result["applied"])

    def test_missing_source_and_wrong_mark_are_blocked(self):
        missing = evaluate_evidence(observation(), alphabet="ascii_hex", source_status="missing")
        wrong_mark = evaluate_evidence(observation(mark="F-32"), alphabet="ascii_hex", source_status="verified")

        self.assertEqual(missing["reason"], "source_missing")
        self.assertEqual(wrong_mark["reason"], "mark_mismatch")
        self.assertIsNone(missing["applied"])
        self.assertIsNone(wrong_mark["applied"])


if __name__ == "__main__":
    unittest.main()

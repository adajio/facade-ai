import unittest

from run import address_receipts, parse_answer


class ReaderOutputTest(unittest.TestCase):
    def test_fenced_fact_with_prose(self):
        self.assertEqual(parse_answer('Сведения прочитаны.\n```json\n{"mark":"F-17"}\n```'), {"mark":"F-17"})

    def test_separate_conflicting_answers_are_not_merged(self):
        self.assertEqual(parse_answer('```json\n{"x":1}\n```\n\n```json\n{"x":2}\n```'), {})
        self.assertEqual(parse_answer('{"x":1}\n```json\n{"x":2}\n```'), {})

    def test_resolves_registered_ref_with_explanation(self):
        receipt={"locator":"s1/v1/call_ab9","sentSha":"hash"}
        self.assertEqual(address_receipts("s1/v1/call_ab9 (верхний блок)", [receipt]), [receipt])
        for bad in ("s1/v1/call_ab", "s1/v1/call_ab999", "s1/v1/call_ab9/child", "s1/v1/call_ab9.fake", "s1/v1/call_ab9 и s1/v1/other"):
            self.assertEqual(address_receipts(bad, [receipt]), [])

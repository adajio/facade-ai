import unittest
from partial_response import complete_observations


class PartialResponseTest(unittest.TestCase):
    def test_only_whole_firsthand_observations_survive(self):
        raw = '{"calls":[],"observations":[{"fact":"A } {","refs":["E1.1"]},{"fact":"cut'
        self.assertEqual(complete_observations(raw), [{"fact": "A } {", "refs": ["E1.1"]}])

    def test_nested_or_quoted_instructions_do_not_become_observations(self):
        raw = '{"other":{"observations":[{"fact":"invented"}]},"observations":['
        self.assertEqual(complete_observations(raw), [])

    def test_reconciliation_is_idempotent_and_rejects_later_receipts(self):
        from partial_response import reconcile_truncated
        snapshot = {"candidates": [], "history": [{"step": 2, "issues": ["unparsed"]}],
                    "delivered": {"E1.1": {"status": "ok"}, "E2.1": {"status": "ok"}}}
        raw = '{"observations":[{"fact":"A","refs":["E1.1","E2.1"]},'
        updated, n = reconcile_truncated(snapshot, lambda step: ("length", raw))
        self.assertEqual(n, 1)
        self.assertEqual(updated["candidates"][0]["delivered_refs"], ["E1.1"])
        self.assertEqual(snapshot["candidates"], [])
        self.assertEqual(reconcile_truncated(updated, lambda step: ("length", raw)), (updated, 0))

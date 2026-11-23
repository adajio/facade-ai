import tempfile
import unittest
from pathlib import Path
from research import run_lane, text_part


class ResearchTest(unittest.TestCase):
    def test_last_results_delivered_and_unknown_refs_retained(self):
        replies = iter(['{"calls":[{"op":"read"}]}',
                       '[{"fact":"A","refs":["E1.1"]},{"fact":"B","refs":["bogus"]},{"op":"again"}]'])
        with tempfile.TemporaryDirectory() as root:
            result = run_lane(Path(root), role="s", inventory="i", steps=1,
                              ask=lambda *args: next(replies), execute=lambda c: [text_part("sample")])
            self.assertEqual([c["delivered_refs"] for c in result["candidates"]], [["E1.1"], []])
            self.assertEqual(result["gaps"][-1]["unserved"], [{"op":"again"}])

    def test_truncated_reply_preserves_completed_fact_and_retains_source_for_next_turn(self):
        seen = []
        replies = iter(['{"calls":[{"op":"read","ref":"d1:p1"}]}',
                        {"text": '{"observations":[{"fact":"A","refs":["E1.1"]},', "finish_reason":"length"},
                        '{"calls":[{"op":"recall","receipt":"E1.1"}]}',
                        '{"observations":[{"fact":"B","refs":["E3.1"]}],"done":true}'])
        def ask(folder, role, parts, final):
            seen.append(parts)
            return next(replies)
        with tempfile.TemporaryDirectory() as root:
            result = run_lane(root, role="s", inventory="i", steps=3, ask=ask,
                              execute=lambda c: [text_part("original document")])
            self.assertIn(text_part("original document"), seen[2])
            self.assertIn(text_part("original document"), seen[3])
            self.assertEqual(result["delivered"]["E3.1"]["call"], {"op":"read","ref":"d1:p1"})
            self.assertEqual(result["candidates"][1]["delivered_refs"], ["E3.1"])
            self.assertTrue(result["candidates"][0]["recovered_complete_item"])
            self.assertEqual(result, run_lane(root, role="s", inventory="i", steps=3, ask=ask, execute=None))

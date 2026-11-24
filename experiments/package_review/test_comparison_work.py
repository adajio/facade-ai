import tempfile
import unittest

from experiments.package_review.comparison_work import comparison_work


class ChildWorkTest(unittest.TestCase):
    def test_restart_continues_beyond_the_first_child_without_losing_receipts(self):
        units = ["a", "b"]
        lines = {"a": ["N1 base", "N2 base"], "b": ["N1.2 mod", "N2.5 mod"]}
        with tempfile.TemporaryDirectory() as directory:
            seen = []
            def first(key, item):
                seen.append(key)
                return {"complete": True, "receipt": "checked"} if key == "n1" else None
            one = comparison_work(directory, units, lines, [True], first)
            self.assertEqual(one["children"]["n2"]["state"], "open")
            seen.clear()
            def second(key, item):
                seen.append(key)
                return {"complete": True, "receipt": "verified"}
            two = comparison_work(directory, units, lines, [], second)
            self.assertEqual(seen, ["n2"])
            self.assertTrue(all(x["state"] == "complete" for x in two["children"].values()))
            with self.assertRaises(ValueError):
                comparison_work(directory, units, {**lines, "b": ["different"]}, [])

    def test_auto_variants_do_not_need_whole_response_or_external_hint(self):
        from experiments.package_review.comparison_work import drain_variants
        tasks = [{"task_id": "t", "units": ["x", "y"], "readers": ["one", "two"], "scope": "s"}]
        units = {"x": ["M8 bulk", "Q2 bulk"], "y": ["M8 base", "M8.2 spare", "Q2 part", "Q2.1 other"]}
        owners = {"x": "doc-a", "y": "doc-b"}
        seen = []
        def read(case, _):
            seen.append(case["family"])
            receipts = [{"reader": r, "unit": u, "receipt": r+u, "location": "L0"}
                        for r in tasks[0]["readers"] for u in case["units"]]
            return "read", receipts, True
        with tempfile.TemporaryDirectory() as directory:
            pending = drain_variants(directory, "rev", tasks, units, owners)
            self.assertEqual([t["status"] for t in pending], ["open", "open"])
            done = drain_variants(directory, "rev", tasks, units, owners, read)
            self.assertEqual([t["status"] for t in done], ["closed", "closed"])
            drain_variants(directory, "rev", tasks, units, owners, read)
            self.assertEqual(seen, ["m8", "q2"])

"""Ensure held packages and unknown attempts remain in the report."""

import unittest

from summarize_trace import PHASES, summarize


class TimelineTests(unittest.TestCase):
    def test_pending_package_does_not_disappear_from_denominator(self):
        group = {"workloadClass": "mixed", "mode": "offline-replay", "routeRevision": "frozen", "projectCount": 2}
        attempt = {"id": "a", "state": "unknown", "spentNanos": 0, "reservedNanos": 100,
                   "promptTokens": None, "completionTokens": None, "timedOut": True}
        run = {
            "startedNs": 0, "observedUntilNs": 1000, "plannedPackageIds": ["small", "large"], "packages": [
                {**group, "id": "small", "startedNs": 5, "state": "complete",
                 "phasesNs": dict(zip(PHASES, [10, 20, 30, 40, 50, 60, 70])), "attempts": []},
                {**group, "id": "large", "startedNs": 5, "state": "held", "reason": "unknown",
                 "phasesNs": {"received": 10}, "attempts": [attempt]},
            ],
        }
        [result] = summarize(run)
        self.assertEqual((result["total"], result["completed"], result["unfinished"]), (2, 1, 1))
        self.assertEqual(result["completedDurationNs"], {"p50": 60, "p95": 60, "max": 60})
        self.assertEqual(result["packages"]["large"]["ageNs"], 995)
        self.assertEqual(result["ledger"]["reservedNanos"], 100)
        self.assertEqual(result["ledger"]["missingTokenCounts"], 1)
        run["packages"].pop()
        with self.assertRaisesRegex(ValueError, "denominator"):
            summarize(run)


if __name__ == "__main__":
    unittest.main()

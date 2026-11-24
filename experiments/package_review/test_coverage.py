import unittest
from document_coverage import covered_documents


class CoverageTest(unittest.TestCase):
    def test_only_acknowledged_source_openings_count(self):
        def receipt(number, op, ref, status="ok"):
            return {"id": number, "call": {"op": op, "ref": ref}, "status": status}
        lanes = {"A": {"whole": {"delivered": {
            "E1.1": receipt("E1.1", "browse", "cad/d1/all"),
            "E1.2": receipt("E1.2", "read", "d2:p1", "error"),
            "E1.3": receipt("E1.3", "read", "d10:p1"),
            "E1.4": receipt("E1.4", "search", "d2")
        }}}}
        states = {r["document"]: r["state"] for r in covered_documents(["d1","d2","d3","d10"], lanes)}
        self.assertEqual(states, {"d1":"catalogue_only", "d2":"catalogue_only", "d3":"no_addressed_opening",
                                  "d10":"addressed_opening"})

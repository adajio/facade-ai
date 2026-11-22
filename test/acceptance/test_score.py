"""Controls for the acceptance oracle, independent of product fixtures."""

import copy
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from score import CONTENT_TYPES, OFFICE_DOCUMENT, RELATIONSHIPS, WORD, WORD_DOCUMENT, score, verify_originals


class AcceptanceControls(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.evidence = Path(temporary.name)
        sha = "ab" * 32
        actual_reading = {"value": "9.2", "unit": "mm"}
        self.address = {"unit": "page:2", "box": [50, 66, 99, 77]}
        place = {"id": "drawing-row", "format": "pdf", "originalSha256": sha,
                 "address": {**self.address, "tolerance": [2, 2]}, "scope": "test west",
                 "revision": "Q12", "critical": True, "readability": "readable",
                 "required": ["A", "B", "merged"], "variants": [actual_reading]}
        entry = {"address": self.address, "originalSha256": sha}
        record = {**entry, "scope": place["scope"], "revision": place["revision"],
                  "citationId": "citation-1", "originalVerified": True,
                  "reading": actual_reading, "presentInCard": True}
        self.gold = {"originals": {"test.pdf": sha}, "places": [place],
                     "letter": {"decisions": {"reference": {"decision": "sufficient", "sources": ["drawing-row"]}},
                                "requests": [], "text": None}}
        self.observed = {"originals": self.gold["originals"], "tracks": {
            track: copy.deepcopy({"shown": [entry],
                                  "opened": [{**entry, "ownOpening": True, "receiptId": "opened-1"}],
                                  "readings": [record]})
            for track in ("A", "B", "merged")}, "files": {},
            "letter": {"decisions": [{"id": "reference", "decision": "sufficient", "sources": ["drawing-row"]}],
                       "requests": [], "exports": {"txt": None, "docx": None},
                       "emptyCreateStatus": 422, "newLetterCount": 0, "letterNumber": None}}

    def evaluate(self):
        return score(self.gold, self.observed, self.evidence)

    def test_empty_expected_letter_and_removal_of_critical_table(self):
        original = self.evaluate()
        self.assertTrue(original["AC03"]["passed"])
        self.assertTrue(original["AC06"]["passed"])
        self.observed["tracks"]["merged"]["readings"].clear()
        removed = self.evaluate()
        self.assertFalse(removed["AC03"]["passed"])
        self.assertEqual(original["AC06"], removed["AC06"])
        self.assertEqual(removed["AC03"]["tracks"]["merged"]["byFormat"]["pdf"]["total"], 1)

    def test_captured_positive_letter_is_preserved_when_critical_table_is_removed(self):
        text = "Запрос\n\n1. Уточните размер по источнику"
        self.gold["letter"].update(text=text, requests=["reference"])
        self.gold["letter"]["decisions"]["reference"]["decision"] = "conflict"
        self.observed["letter"]["decisions"][0]["decision"] = "conflict"
        self.observed["letter"].update(requests=["reference"], exports={"txt": "letter.txt", "docx": "letter.docx"})
        self.observed["files"].update({"letter.txt": "hash", "letter.docx": "hash"})
        (self.evidence / "letter.txt").write_text(text, encoding="utf-8")
        paragraphs = "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in text.split("\n"))
        namespace = WORD[1:-1]
        with ZipFile(self.evidence / "letter.docx", "w") as docx:
            docx.writestr("[Content_Types].xml", f'<Types xmlns="{CONTENT_TYPES[1:-1]}">'
                          f'<Override PartName="/word/document.xml" ContentType="{WORD_DOCUMENT}"/></Types>')
            docx.writestr("_rels/.rels", f'<Relationships xmlns="{RELATIONSHIPS[1:-1]}">'
                          f'<Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/>'
                          '</Relationships>')
            docx.writestr("word/document.xml", f'<w:document xmlns:w="{namespace}"><w:body>'
                          f"{paragraphs}</w:body></w:document>")
        self.assertTrue(self.evaluate()["AC06"]["passed"])
        self.observed["tracks"]["merged"]["readings"].clear()
        removed = self.evaluate()
        self.assertFalse(removed["AC03"]["passed"])
        self.assertTrue(removed["AC06"]["passed"])
        (self.evidence / "letter.txt").write_text(text + "!", encoding="utf-8")
        self.assertFalse(self.evaluate()["AC06"]["passed"])

    def test_automatic_display_does_not_pass_missing_independent_open(self):
        self.observed["tracks"]["A"]["opened"].clear()
        evaluated = self.evaluate()["AC03"]
        self.assertFalse(evaluated["passed"])
        result = evaluated["tracks"]["A"]["places"]["drawing-row"]
        self.assertTrue(result["shown"])
        self.assertFalse(result["selfOpened"])
        self.assertTrue(evaluated["tracks"]["merged"]["places"]["drawing-row"]["passed"])

    def test_wrong_value_unit_scope_revision_or_address(self):
        target = self.observed["tracks"]["B"]["readings"][0]
        for key, value in [
            ("reading", {"value": "9.2", "unit": "m"}), ("scope", "neighbor"), ("revision", "old"),
            ("address", {"unit": "page:1"}), ("originalVerified", False),
        ]:
            with self.subTest(key=key):
                original = target[key]
                target[key] = value
                self.assertFalse(self.evaluate()["AC03"]["passed"])
                target[key] = original

    def test_unreadable_is_addressed_limit_with_no_external_request(self):
        self.gold["places"][0].update(readability="unreadable", variants=[])
        for track in self.observed["tracks"].values():
            track["readings"][0].update(limitation="blurred cell", reading=None)
        self.assertTrue(self.evaluate()["AC03"]["passed"])
        self.observed["letter"]["requests"] = ["reference"]
        result = self.evaluate()
        self.assertTrue(result["AC03"]["passed"])
        self.assertEqual(result["AC06"]["falseRequests"], {"reference": 1})
        self.assertFalse(result["AC06"]["passed"])

    def test_added_original_is_detected(self):
        (self.evidence / "unexpected.txt").touch()
        with self.assertRaisesRegex(ValueError, "differs from"):
            verify_originals(self.evidence, self.gold["originals"])


if __name__ == "__main__":
    unittest.main()

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

from generate import generate

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("acceptance_score", HERE / "../acceptance/score.py")
SCORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCORE)


def replay(gold):
    """Construct a scorer self-test from known observations, outside the app/reader."""
    tracks = {}
    for track in SCORE.TRACKS:
        readings = []
        for place in gold["places"]:
            readings.append({
                **{key: place[key] for key in ("originalSha256", "address", "scope", "revision")},
                "oracleId": place["id"],
                "citationId": f"{track}-{place['id']}",
                "originalVerified": True,
                "ownOpening": track != "merged",
                "receiptId": f"fixture-{track}-{place['id']}",
                "presentInCard": track == "merged",
                "reading": place["variants"][0] if place["variants"] else None,
                "limitation": None if place["variants"] else "unreadable_cell",
            })
        tracks[track] = {
            "shown": [item for place, item in zip(gold["places"], readings) if place["nativeCandidates"]],
            "opened": copy.deepcopy(readings) if track != "merged" else [],
            "readings": readings,
        }

    letter = gold["letter"]
    return {
        "originals": gold["originals"],
        "tracks": tracks,
        "letter": {
            "decisions": [{"id": key, **value} for key, value in letter["decisions"].items()],
            "requests": letter["requests"],
            "letterNumber": None,
            "exports": {"txt": None, "docx": None},
            "emptyCreateStatus": 422,
            "newLetterCount": 0,
        },
    }


def write_docx(path, text):
    document = ElementTree.Element(f"{SCORE.WORD}document")
    body = ElementTree.SubElement(document, f"{SCORE.WORD}body")
    for line in text.split("\n"):
        paragraph = ElementTree.SubElement(body, f"{SCORE.WORD}p")
        run = ElementTree.SubElement(paragraph, f"{SCORE.WORD}r")
        ElementTree.SubElement(run, f"{SCORE.WORD}t", {
            "{http://www.w3.org/XML/1998/namespace}space": "preserve",
        }).text = line
    content_types = ElementTree.Element(f"{SCORE.CONTENT_TYPES}Types")
    ElementTree.SubElement(content_types, f"{SCORE.CONTENT_TYPES}Default", {
        "Extension": "rels",
        "ContentType": "application/vnd.openxmlformats-package.relationships+xml",
    })
    ElementTree.SubElement(content_types, f"{SCORE.CONTENT_TYPES}Override", {
        "PartName": "/word/document.xml",
        "ContentType": SCORE.WORD_DOCUMENT,
    })
    relationships = ElementTree.Element(f"{SCORE.RELATIONSHIPS}Relationships")
    ElementTree.SubElement(relationships, f"{SCORE.RELATIONSHIPS}Relationship", {
        "Id": "rId1", "Type": SCORE.OFFICE_DOCUMENT, "Target": "word/document.xml",
    })
    with ZipFile(path, "w") as archive:
        for name, root in (("[Content_Types].xml", content_types), ("_rels/.rels", relationships),
                           ("word/document.xml", document)):
            archive.writestr(name, ElementTree.tostring(root, encoding="utf-8", xml_declaration=True))


class TrainingFixturesTest(unittest.TestCase):
    def setUp(self):
        self.gold = json.loads((HERE / "gold/training.json").read_text(encoding="utf-8"))

    def test_generator_is_reproducible(self):
        SCORE.verify_files(HERE / "input", self.gold["originals"])
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory)
            generate(generated)
            for name in [*(f"input/{name}" for name in self.gold["originals"]), "gold/training.json"]:
                self.assertEqual((HERE / name).read_bytes(), (generated / name).read_bytes(), name)

    def test_critical_zero_candidate_place_must_be_read_even_with_correct_empty_letter(self):
        captured = replay(self.gold)
        positive = SCORE.score(self.gold, captured, HERE)
        self.assertTrue(positive["AC03"]["passed"])
        self.assertTrue(positive["AC06"]["passed"])

        control = self.gold["scenarios"]["zeroCandidatesNegativeControl"]
        critical = control["removeReading"]
        for track in captured["tracks"].values():
            track["readings"] = [reading for reading in track["readings"] if reading["oracleId"] != critical]
        negative = SCORE.score(self.gold, captured, HERE)
        self.assertEqual(negative["AC03"]["passed"], control["expectedAC03"])
        self.assertEqual(negative["AC06"]["passed"], control["expectedAC06"])
        for track in negative["AC03"]["tracks"].values():
            self.assertEqual(track["byFormat"]["pdf"]["total"], len(self.gold["places"]))
            self.assertFalse(track["places"][critical]["shown"])
            self.assertFalse(track["places"][critical]["passed"])

    def test_invented_value_on_unreadable_cell_fails_recognition(self):
        captured = replay(self.gold)
        reading = next(item for item in captured["tracks"]["A"]["readings"]
                       if item["oracleId"] == "fb-r2-width-unreadable")
        reading["reading"] = {"value": "900", "unit": "mm"}
        result = SCORE.score(self.gold, captured, HERE)
        self.assertFalse(result["AC03"]["passed"])
        self.assertTrue(result["AC06"]["passed"])

    def test_whole_letter_in_txt_and_docx_is_independent_of_recognition(self):
        selected = self.gold["scenarios"]["initial"]
        self.gold["letter"] = selected["letter"]
        self.gold["originals"] = {name: self.gold["originals"][name] for name in selected["originals"]}
        self.gold["places"] = [place for place in self.gold["places"] if place["source"] in selected["originals"]]
        captured = replay(self.gold)
        captured["letter"]["exports"] = {"txt": "letter.txt", "docx": "letter.docx"}

        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            text = selected["letter"]["text"]
            (evidence / "letter.txt").write_text(text, encoding="utf-8")
            write_docx(evidence / "letter.docx", text)
            captured["files"] = {name: SCORE.digest(evidence / name)
                                 for name in captured["letter"]["exports"].values()}
            result = SCORE.score(self.gold, captured, evidence)
            self.assertTrue(result["AC03"]["passed"])
            self.assertTrue(result["AC06"]["passed"])

            write_docx(evidence / "letter.docx", text.replace("2 мм", "20 мм"))
            captured["files"]["letter.docx"] = SCORE.digest(evidence / "letter.docx")
            result = SCORE.score(self.gold, captured, evidence)
            self.assertTrue(result["AC03"]["passed"])
            self.assertFalse(result["AC06"]["passed"])


if __name__ == "__main__":
    unittest.main()

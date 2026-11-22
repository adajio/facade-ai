"""Score a frozen observation privately. Standard-library only. See README.md."""

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile


TRACKS = ("A", "B", "merged")
DECISIONS = ("sufficient", "missing", "conflict", "unreadable", "indeterminate")
WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
CONTENT_TYPES = "{http://schemas.openxmlformats.org/package/2006/content-types}"
RELATIONSHIPS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
WORD_DOCUMENT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def in_directory(directory, name):
    path = (directory / name).resolve()
    if not path.is_relative_to(directory.resolve()):
        raise ValueError("Evidence path escapes its directory")
    return path


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def verify_files(directory, hashes):
    if not hashes:
        raise ValueError("Empty file manifest")
    for name, sha256 in hashes.items():
        if digest(in_directory(directory, name)) != sha256:
            raise ValueError(f"SHA-256 mismatch: {name}")


def verify_originals(directory, hashes):
    entries = list(directory.rglob("*"))
    if any(path.is_symlink() for path in entries):
        raise ValueError("Symlink in original package")
    names = {path.relative_to(directory).as_posix() for path in entries if path.is_file()}
    if names != set(hashes):
        raise ValueError("Original package differs from the frozen manifest")
    verify_files(directory, hashes)


def address_matches(expected, actual):
    """Match the physical unit and, for a PDF or drawing, its validated window."""
    if not isinstance(actual, dict) or expected["unit"] != actual.get("unit"):
        return False
    if "box" not in expected:
        return True
    box = actual.get("box")
    if not isinstance(box, list) or len(box) != 4 or any(type(point) not in (int, float) for point in box):
        return False
    x1, y1, x2, y2 = box
    a1, b1, a2, b2 = expected["box"]
    dx, dy = expected["tolerance"]
    return (
        a1 - dx <= x1 <= a1 + dx
        and b1 - dy <= y1 <= b1 + dy
        and a2 - dx <= x2 <= a2 + dx
        and b2 - dy <= y2 <= b2 + dy
        and x1 < x2
        and y1 < y2
    )


def same_location(place, record):
    return (
        place["originalSha256"] == record.get("originalSha256")
        and address_matches(place["address"], record.get("address"))
    )


def covers_location(place, record):
    actual = record.get("address")
    expected = place["address"]
    if (place["originalSha256"] != record.get("originalSha256") or not isinstance(actual, dict)
            or expected["unit"] != actual.get("unit")):
        return False
    if "box" not in expected or actual.get("wholeUnit") is True:
        return True
    if address_matches(expected, actual):
        return True
    box = actual.get("box")
    if not isinstance(box, list) or len(box) != 4 or any(type(point) not in (int, float) for point in box):
        return False
    x1, y1, x2, y2 = expected["box"]
    left, top, right, bottom = box
    return left <= x1 < x2 <= right and top <= y1 < y2 <= bottom


def valid_reading(place, record):
    if any(place[key] != record.get(key) for key in ("scope", "revision")):
        return False
    if not record.get("citationId") or record.get("originalVerified") is not True:
        return False
    if place["readability"] == "unreadable":
        return bool(record.get("limitation")) and record.get("reading") is None
    return record.get("reading") in place["variants"] and not record.get("limitation")


def score_recognition(places, tracks):
    details = {}
    verdict = True
    for track in TRACKS:
        captured = tracks[track]
        cases = {}
        by_format = {}
        for place in places:
            shown = any(covers_location(place, item) for item in captured["shown"])
            opened = any(
                covers_location(place, item) and item.get("ownOpening") is True and item.get("receiptId")
                for item in captured["opened"]
            )
            readings = [item for item in captured["readings"] if same_location(place, item)]
            valid = [item for item in readings if valid_reading(place, item)]
            incorrect = len(valid) != len(readings)
            exact = bool(valid) and not incorrect
            retained = any(item.get("presentInCard") is True for item in valid) and not incorrect
            required = track in place["required"]
            passed = exact and (retained if track == "merged" else opened) and not incorrect
            verdict &= not required or passed
            cases[place["id"]] = {
                "required": required, "shown": shown, "selfOpened": opened,
                "exactOrAddressedLimit": exact, "retained": retained,
                "incorrectAtAddress": incorrect, "passed": passed,
            }
            counts = by_format.setdefault(place["format"], Counter())
            counts.update({
                "total": 1, "required": int(required), "passedRequired": int(required and passed),
                "shown": int(shown), "selfOpened": int(opened), "exactOrAddressedLimit": int(exact),
                "retained": int(retained), "incorrectAtAddress": int(incorrect),
            })
        details[track] = {"byFormat": by_format, "places": cases}
    return {"passed": verdict, "tracks": details}


def docx_text(path):
    with ZipFile(path) as archive:
        content_types = ElementTree.fromstring(archive.read("[Content_Types].xml"))
        root_links = ElementTree.fromstring(archive.read("_rels/.rels"))
        if not any(
            node.get("PartName") == "/word/document.xml" and node.get("ContentType") == WORD_DOCUMENT
            for node in content_types.findall(f"{CONTENT_TYPES}Override")
        ) or not any(
            link.get("Type") == OFFICE_DOCUMENT and link.get("Target") in {"word/document.xml", "/word/document.xml"}
            for link in root_links.findall(f"{RELATIONSHIPS}Relationship")
        ):
            raise ValueError("Export is missing the DOCX main document declaration")
        document = ElementTree.fromstring(archive.read("word/document.xml"))
    body = document.find(f"{WORD}body")
    if body is None:
        raise ValueError("DOCX has no document body")
    paragraphs = []
    for paragraph in body.iter(f"{WORD}p"):
        parts = []
        for node in paragraph.iter():
            if node.tag == f"{WORD}t":
                parts.append(node.text or "")
            elif node.tag in (f"{WORD}br", f"{WORD}cr"):
                parts.append("\n")
            elif node.tag == f"{WORD}tab":
                parts.append("\t")
        paragraphs.append("".join(parts))
    return "\n".join(paragraphs)


def normalized(text):
    return text.replace("\r\n", "\n").removesuffix("\n")


def score_letter(expected, actual, evidence_dir):
    decisions = actual["decisions"]
    keys = [item["id"] for item in decisions]
    if any(item["decision"] not in DECISIONS for item in decisions):
        raise ValueError("Unrecognized decision")
    wanted = expected["decisions"]
    actual_decisions = {item["id"]: {key: item[key] for key in ("decision", "sources")}
                        for item in decisions}
    for item in actual_decisions.values():
        item["sources"] = sorted(item["sources"])
    expected_decisions = {
        key: {"decision": item["decision"], "sources": sorted(item["sources"])}
        for key, item in wanted.items()
    }
    same_decisions = len(set(keys)) == len(keys) and actual_decisions == expected_decisions
    expected_requests = Counter(expected["requests"])
    actual_requests = Counter(actual["requests"])
    text = expected["text"]
    exports = actual["exports"]
    if text is None:
        export_pass = all(value is None for value in exports.values())
        export_pass &= set(exports) == {"txt", "docx"}
        export_pass &= actual["emptyCreateStatus"] == 422
        export_pass &= actual["newLetterCount"] == 0
        export_pass &= actual["letterNumber"] is None
    else:
        export_pass = set(exports) == {"txt", "docx"} and all(exports.values())
        if export_pass:
            txt_file = in_directory(evidence_dir, exports["txt"])
            docx_file = in_directory(evidence_dir, exports["docx"])
            export_pass = normalized(txt_file.read_text(encoding="utf-8")) == normalized(text)
            export_pass &= normalized(docx_text(docx_file)) == normalized(text)
    return {
        "passed": same_decisions and export_pass and actual_requests == expected_requests,
        "decisionsMatch": same_decisions,
        "exportsMatch": bool(export_pass),
        "falseRequests": dict(actual_requests - expected_requests),
        "missedRequests": dict(expected_requests - actual_requests),
    }


def score(gold, observed, evidence_dir):
    if observed["originals"] != gold["originals"]:
        raise ValueError("Observation and oracle describe different original bytes")
    place_ids = [place["id"] for place in gold["places"]]
    if not place_ids or len(set(place_ids)) != len(place_ids):
        raise ValueError("Missing or duplicate places in oracle")
    if any(place["critical"] and "merged" not in place["required"] for place in gold["places"]):
        raise ValueError("Critical place excluded from merged obligations")
    for name in observed["letter"]["exports"].values():
        if name is not None and name not in observed["files"]:
            raise ValueError("Export missing from frozen evidence manifest")
    return {
        "AC03": score_recognition(gold["places"], observed["tracks"]),
        "AC06": score_letter(gold["letter"], observed["letter"], evidence_dir),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("oracle", type=Path)
    parser.add_argument("observations", type=Path)
    parser.add_argument("originals", type=Path)
    args = parser.parse_args()

    gold = load(args.oracle)
    observed = load(args.observations)
    verify_originals(args.originals, gold["originals"])
    verify_files(args.observations.parent, observed["files"])
    result = score(gold, observed, args.observations.parent)
    result["oracleSha256"] = digest(args.oracle)
    result["observationsSha256"] = digest(args.observations)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if all(result[item]["passed"] for item in ("AC03", "AC06")) else 1


if __name__ == "__main__":
    raise SystemExit(main())

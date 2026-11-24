"""Validate the private fixture without logging its filenames, labels, or answers."""

from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as XML
from collections import Counter
import argparse
import io
import json
import subprocess


def check(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def source_index(root, manifest):
    index = {}
    for case, files in manifest.items():
        path = root / "intake-input" / case
        check(path.is_dir(), "Packet missing")
        check({file.name for file in path.iterdir()} == {file["file"] for file in files}, "Packet contents differ")
        for entry in files:
            source = path / entry["file"]
            check(source.is_file() and not source.is_symlink(), "Invalid original path")
            digest = sha256(source.read_bytes()).hexdigest()
            check(digest == entry["sha256"], "Original changed")
            index[digest] = source
    return index


def text_nodes(element, name):
    return "".join(node.text or "" for node in element.iter() if node.tag.rsplit("}", 1)[-1] == name)


def read_anchor(path, address):
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        page = str(address["page"])
        command = ["pdftotext", "-f", page, "-l", page, "-layout", str(path), "-"]
        return subprocess.run(command, check=True, capture_output=True, text=True, timeout=10).stdout
    if suffix == ".txt":
        return path.read_text(encoding="utf-8").splitlines()[address["line"] - 1]
    if suffix == ".xlsx":
        with ZipFile(path) as package:
            book = XML.fromstring(package.read("xl/workbook.xml"))
            sheets = [sheet.get("name") for sheet in book.findall(".//{*}sheet")]
            sheet = sheets.index(address["sheet"]) + 1
            entries = XML.fromstring(package.read(f"xl/worksheets/sheet{sheet}.xml"))
            cell = next(item for item in entries.findall(".//{*}c") if item.get("r") == address["cell"])
            return text_nodes(cell, "t")
    if suffix == ".docx":
        with ZipFile(path) as package:
            document = XML.fromstring(package.read("word/document.xml"))
            paragraph = document.find("{*}body").findall("{*}p")[address["paragraph"] - 1]
            return text_nodes(paragraph, "t")
    if suffix == ".dxf":
        lines = iter(path.read_text(encoding="ascii").splitlines())
        groups = [(int(key), value) for key, value in zip(lines, lines, strict=True)]
        for index, (code, value) in enumerate(groups):
            if (code, value) != (5, address["handle"]):
                continue
            tags = {}
            for tag, item in groups[index:]:
                if tag == 0:
                    break
                tags[tag] = item
            check(tags.get(410) == address["space"], "DXF space differs")
            return tags[1]
        raise ValueError("DXF handle missing")
    raise ValueError("Unknown anchor format")


def anchors(data):
    if isinstance(data, dict):
        if {"source", "literal", "address"} <= data.keys():
            yield data
        else:
            for item in data.values():
                yield from anchors(item)
    elif isinstance(data, list):
        for item in data:
            yield from anchors(item)


def audit(root, repo):
    vault = root / "closed-oracle"
    frozen = read_json(root / "sealed-receipt.json")
    for name in ("oracle", "matrix", "input_map"):
        file = vault / (name.replace("_", "-") + ".json")
        check(sha256(file.read_bytes()).hexdigest() == frozen[f"{name}_sha256"], "Frozen manifest changed")
    index = source_index(root, read_json(vault / "input-map.json"))
    gold = read_json(vault / "oracle.json")
    address_counts = Counter()
    for item in anchors(gold):
        path = index[item["source"]["sha256"]]
        record = read_anchor(path, item["address"])
        normalize = lambda text: " ".join(text.split())
        check(normalize(item["literal"]) in normalize(record), "A blind anchor is outside its declared address")
        address_counts[path.suffix] += 1
    for archived in (root / "intake-input" / "open_archive").glob("*.zip"):
        with ZipFile(archived) as outer:
            check(outer.testzip() is None and len(outer.namelist()) == 1, "Broken outer archive")
            with ZipFile(io.BytesIO(outer.read(outer.namelist()[0]))) as inner:
                check(inner.testzip() is None and len(inner.namelist()) >= 2, "Broken inner archive")
                check(all(sha256(inner.read(name)).hexdigest() in index for name in inner.namelist()), "Unexpected nested original")
    sizes = {path.stat().st_size for path in index.values()}
    roots = ["test/fixtures", "src/modules/formats/test/fixtures", "fixtures"]
    for directory in roots:
        for file in (repo / directory).rglob("*"):
            if not file.is_file() or file.is_symlink() or file.stat().st_size not in sizes:
                continue
            check(sha256(file.read_bytes()).hexdigest() not in index, "Original overlaps development fixtures")
    check(len(gold["facades"]) == 2, "Oracle must distinguish two facades")
    check(set(gold["baseline"]["assessment"].values()) == {"complete", "confirmed_missing"}, "Assessment controls differ")
    return {"cases": frozen["cases"], "originals": len(index), "addresses": dict(address_counts),
            "oracleSha256": frozen["oracle_sha256"], "noDevelopmentOverlap": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("repo", type=Path)
    args = parser.parse_args()
    print(json.dumps(audit(args.root, args.repo), sort_keys=True))

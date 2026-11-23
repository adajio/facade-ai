"""Validate a protected project-memory fixture without printing answers or paths."""
from hashlib import sha256
import json
from pathlib import Path
from subprocess import SubprocessError, run
import sys
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def sealed_json(path):
    assert path.is_file() and not path.is_symlink()
    assert path.stat().st_mode & 0o077 == 0
    return json.loads(path.read_text())


def supports(value):
    if isinstance(value, dict):
        if "file" in value and ("page" in value or "sheet" in value):
            yield value
        else:
            for nested in value.values():
                yield from supports(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from supports(nested)


def native_pdf(path):
    result = run(
        ["pdftotext", "-layout", str(path), "-"], check=True, capture_output=True, text=True
    )
    return [[line.strip() for line in page.splitlines() if line.strip()]
            for page in result.stdout.rstrip("\f").split("\f")]


def native_cells(path):
    with ZipFile(path) as book:
        assert book.testzip() is None and not any("/externalLink" in name for name in book.namelist())
        workbook = ElementTree.fromstring(book.read("xl/workbook.xml"))
        names = [sheet.get("name") for sheet in workbook.iter(MAIN + "sheet")]
        return {
            name: {
                cell.attrib["r"]: "".join(cell.itertext())
                for cell in ElementTree.fromstring(book.read(f"xl/worksheets/sheet{index}.xml")).iter(MAIN + "c")
            }
            for index, name in enumerate(names, 1)
        }


def verify(root):
    manifest_path = root / "verifier" / "manifest.json"
    manifest = sealed_json(manifest_path)
    oracle_path = root / "verifier" / "oracle.json"
    oracle = sealed_json(oracle_path)
    assert digest(oracle_path) == manifest["oracleSha256"]
    assert manifest["freezeBeforeAnyRead"] and manifest["classification"] == "synthetic"
    assert manifest["totalBudgetUsdNanos"] == 5_000_000_000
    assert oracle["classification"] == "verifier-only"
    for child in ("initial", "supplement", "verifier"):
        private = root / child
        assert private.is_dir() and not private.is_symlink() and not private.stat().st_mode & 0o077

    files = {}
    for original in manifest["originals"]:
        relative = Path(original["path"])
        assert len(relative.parts) == 2 and relative.parts[0] in {"initial", "supplement"}
        assert relative.name not in files and relative.suffix in {".pdf", ".xlsx"}
        path = root / relative
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == original["bytes"] and digest(path) == original["sha256"]
        files[relative.name] = path
    actual = {path for phase in ("initial", "supplement") for path in (root / phase).iterdir()}
    assert actual == set(files.values()) and len(files) == 5

    pdfs = {name: native_pdf(path) for name, path in files.items() if path.suffix == ".pdf"}
    books = {name: native_cells(path) for name, path in files.items() if path.suffix == ".xlsx"}
    assert len(pdfs) == 4 and len(books) == 1
    resolved = list(supports(oracle["expected"]))
    assert resolved
    for anchor in resolved:
        if "page" in anchor:
            lines = pdfs[anchor["file"]][anchor["page"] - 1]
            assert 0 < anchor["line"] <= len(lines)
        else:
            cells = books[anchor["file"]][anchor["sheet"]]
            assert all(cells.get(address) for address in anchor["cells"])

    facades = oracle["facades"]
    assert len(facades) == 2 and len({row["kind"] for row in facades}) == 2
    assert len({row["id"] for row in facades}) == 2 and len({row["variant"] for row in facades}) == 2
    followup = oracle["expected"]["lateQuestion"]
    answer = followup["answer"]
    late = followup["requiredInPreviouslyUnselectedBlock"][0]
    current = books[late["file"]][late["sheet"]]
    assert answer["color"] in {current[cell] for cell in late["cells"]}
    assert answer["color"] not in followup["prompt"]
    assert answer["facade"] == facades[1]["id"]
    assert all('"' + answer["color"] + '"' not in path.read_text()
               for path in (root / "reports").glob("*.json") if path.name.startswith("public-"))

    return {
        "manifestSha256": digest(manifest_path),
        "initial": sum(path.parent.name == "initial" for path in files.values()),
        "supplement": sum(path.parent.name == "supplement" for path in files.values()),
        "facades": len(facades),
        "nativeFormats": ["PDF", "XLSX"],
        "nativeAddressesChecked": len(resolved),
        "budgetUsdNanos": manifest["totalBudgetUsdNanos"],
    }


if __name__ == "__main__":
    try:
        result = verify(Path(sys.argv[1]))
    except (AssertionError, BadZipFile, ElementTree.ParseError, IndexError, KeyError, OSError,
            SubprocessError, ValueError) as failure:
        print("Fixture integrity verification failed:", type(failure).__name__, file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(result, sort_keys=True))

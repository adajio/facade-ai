"""Generate the public training PDFs and independent annotations with Python stdlib."""

import hashlib
import json
from pathlib import Path

WIDTH, HEIGHT = 612, 432
PIXEL_WIDTH, PIXEL_HEIGHT = 720, 240
FONT = {
    "0": "0E11111111110E", "1": "040C040404040E", "2": "0E11010204081F",
    "A": "0E11111F111111", "B": "1E11111E11111E", "D": "1E11111111111E",
    "E": "1F10101E10101F", "F": "1F10101E101010", "H": "1111111F111111",
    "I": "0E04040404040E", "M": "111B1515111111", "R": "1E11111E141211",
    "T": "1F040404040404", "W": "11111115151B11", "-": "0000001F000000",
    " ": "00000000000000",
}


def pdf_stream(data, options=b""):
    return b"<< /Length %d %s>>\nstream\n%s\nendstream" % (len(data), options, data)


def render_pdf(pages):
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    children = []
    for instructions, image in pages:
        resources = b"/Font << /F1 3 0 R >>"
        if image is not None:
            options = (b"/Type /XObject /Subtype /Image /Width %d /Height %d "
                       b"/ColorSpace /DeviceGray /BitsPerComponent 1 ") % (PIXEL_WIDTH, PIXEL_HEIGHT)
            objects.append(pdf_stream(image, options))
            resources += b" /XObject << /Im0 %d 0 R >>" % len(objects)
        objects.append(pdf_stream(instructions))
        objects.append(
            (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
             b"/Resources << %s >> /Contents %d 0 R >>") % (WIDTH, HEIGHT, resources, len(objects))
        )
        children.append(b"%d 0 R" % len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(children), len(children))

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(b"%d 0 obj\n%s\nendobj\n" % (index, body))
    xref = len(output)
    output.extend(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        output.extend(b"%010d 00000 n \n" % offset)
    output.extend(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
                  % (len(objects) + 1, xref))
    return bytes(output)


def native_text(*rows):
    pieces = []
    for x, y, size, text in rows:
        safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        pieces.append(f"BT /F1 {size} Tf {x} {y} Td ({safe}) Tj ET")
    return "\n".join(pieces).encode("ascii")


def raster_table():
    pixels = bytearray(b"\xff" * (PIXEL_WIDTH // 8 * PIXEL_HEIGHT))

    def rect(x, y, width, height):
        for row in range(y, y + height):
            for column in range(x, x + width):
                offset = row * (PIXEL_WIDTH // 8) + column // 8
                pixels[offset] &= ~(128 >> (column % 8))

    def text(x, y, value):
        scale = 3
        for char in value:
            for row, bits in enumerate(bytes.fromhex(FONT[char])):
                for column in range(5):
                    if bits & (16 >> column):
                        rect(x + column * scale, y + row * scale, scale, scale)
            x += 6 * scale

    for y in (20, 75, 139, 208):
        rect(20, y, 680, 2)
    for x in (20, 160, 260, 500, 698):
        rect(x, 20, 2, 190)

    for x, heading in ((43, "F"), (182, "R"), (314, "WIDTH MM"), (560, "MM")):
        text(x, 38, heading)
    for y, mark in ((96, "R1"), (161, "R2")):
        text(43, y, "F-B")
        text(182, y, mark)
        text(314, y, "WIDTH")
    text(555, 96, "1200")
    # The synthetic damage contains no hidden text or recoverable value.
    for x in range(536, 661, 9):
        rect(x, 156 + x % 13, 7, 24)
    rect(530, 166, 143, 8)
    return bytes(pixels)


def generate(directory):
    package = render_pdf([
        (native_text(
            (36, 379, 20, "Training package - material schedule"),
            (36, 325, 14, "F-A    R1    Thickness (mm)    2"),
            (36, 283, 14, "F-B    R1    Thickness (mm)    3"),
            (36, 234, 12, "F-A attachment detail: not included in this delivery"),
        ), None),
        (b"q 540 0 0 180 36 160 cm /Im0 Do Q", raster_table()),
    ])
    supplement = render_pdf([
        (native_text(
            (36, 379, 20, "Supplement - attachment detail"),
            (36, 325, 14, "F-A    R1    Attachment detail   D-01"),
            (36, 283, 14, "F-A    R1    Thickness (mm)    2"),
        ), None),
    ])
    originals = {
        "facade-package.pdf": package,
        "facade-supplement.pdf": supplement,
    }

    fixture_input = directory / "input"
    fixture_gold = directory / "gold"
    for folder in (fixture_input, fixture_gold):
        folder.mkdir(parents=True, exist_ok=True)
    for name, data in originals.items():
        (fixture_input / name).write_bytes(data)
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in originals.items()}

    def place(identifier, source, page, box, scope, edition, reading=None, *,
              required=("A", "B", "merged"), critical=False, native_candidates=True):
        return {
            "id": identifier,
            "source": source,
            "originalSha256": hashes[source],
            "address": {"unit": str(page), "box": box, "tolerance": [15, 12]},
            "format": "pdf",
            "scope": scope,
            "revision": edition,
            "readability": "readable" if reading else "unreadable",
            "variants": [reading] if reading else [],
            "critical": critical,
            "required": list(required),
            "nativeCandidates": native_candidates,
        }

    initial, later = originals.keys()
    baseline = [
        place("fa-r1-thickness", initial, 1, [36, 97, 230, 110], "F-A", "initial",
              {"value": "2", "unit": "mm"}, critical=True),
        place("fb-r1-thickness", initial, 1, [36, 139, 230, 152], "F-B", "initial",
              {"value": "3", "unit": "mm"}),
        place("fa-r1-attachment-notice", initial, 1, [36, 189, 301, 201], "F-A", "initial",
              {"value": "not included in this delivery", "unit": ""}),
        place("fb-r1-width-raster", initial, 2, [51, 148, 560, 196], "F-B", "initial",
              {"value": "1200", "unit": "mm"}, critical=True, native_candidates=False),
        place("fb-r2-width-unreadable", initial, 2, [51, 196, 560, 248], "F-B", "initial",
              native_candidates=False),
    ]
    supplied = place("fa-r1-attachment", later, 1, [36, 97, 258, 110], "F-A", "supplement",
                     {"value": "D-01", "unit": ""}, critical=True)
    received_thickness = place(
        "fa-r1-thickness-supplement", later, 1, [36, 139, 230, 152], "F-A", "supplement",
        {"value": "2", "unit": "mm"},
    )
    letter = {
        "decisions": {
            "fa-r1-thickness": {"decision": "sufficient", "sources": ["fa-r1-thickness"]},
            "fa-r1-attachment": {
                "decision": "missing", "sources": ["fa-r1-thickness", "fa-r1-attachment-notice"],
            },
            "fb-r1-thickness": {"decision": "sufficient", "sources": ["fb-r1-thickness"]},
            "fb-r1-width": {"decision": "sufficient", "sources": ["fb-r1-width-raster"]},
            "fb-r2-width": {"decision": "unreadable", "sources": ["fb-r2-width-unreadable"]},
        },
        "requests": ["fa-r1-attachment"],
        "text": "Запрос исходных данных\n\nКому: Проектная группа\n\n"
                "1. Предоставьте узел крепления R1 фасада F-A. "
                "В ведомости материалов (facade-package.pdf, лист 1) указана толщина 2 мм.",
    }
    no_letter = {
        "decisions": {
            **letter["decisions"],
            "fa-r1-attachment": {"decision": "sufficient", "sources": [supplied["id"]]},
        },
        "requests": [],
        "text": None,
    }
    gold = {
        "edition": 1,
        "coordinates": "PDF points from top left, [xMin, yMin, xMax, yMax]",
        "originals": hashes,
        "places": baseline + [supplied, received_thickness],
        "letter": no_letter,
        "scenarios": {
            "initial": {"originals": [initial], "letter": letter},
            "afterSupplement": {"originals": [initial, later], "letter": no_letter},
            "completeFacade": {"scope": "F-A", "letter": {
                **no_letter, "decisions": {
                    key: value for key, value in no_letter["decisions"].items() if key.startswith("fa-")
                },
            }},
            "internalOnly": {"scope": "F-B", "letter": {
                **no_letter, "decisions": {
                    key: value for key, value in no_letter["decisions"].items() if key.startswith("fb-")
                },
            }},
            "zeroCandidatesNegativeControl": {"removeReading": "fb-r1-width-raster",
                                              "expectedAC03": False, "expectedAC06": True},
        },
    }
    (fixture_gold / "training.json").write_text(
        json.dumps(gold, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
    )


if __name__ == "__main__":
    generate(Path(__file__).resolve().parent)

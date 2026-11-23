"""Локальная проверка спецификации доставки пикселей на синтетическом PDF."""
import base64
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "recognition"


def render(pdf, page, box, width, scratch):
    left, top, right, bottom = box
    prefix = scratch / "region"
    scale = width / (right - left)
    subprocess.run([
        "pdftoppm", "-f", str(page), "-l", str(page), "-r", str(72 * scale),
        "-x", str(round(left * scale)), "-y", str(round(top * scale)),
        "-W", str(width), "-H", str(round((bottom - top) * scale)),
        "-singlefile", "-png", str(pdf), str(prefix),
    ], check=True)
    return prefix.with_suffix(".png").read_bytes()


def serialize_image(pixels):
    return json.dumps({"parts": [{"type": "image", "mime": "image/png",
                                  "base64": base64.b64encode(pixels).decode("ascii")}]})


def inspect_image(wire, expected_hash, size):
    part = json.loads(wire)["parts"][0]
    if part["type"] != "image" or part["mime"] != "image/png":
        return False
    pixels = base64.b64decode(part["base64"], validate=True)
    return (pixels.startswith(b"\x89PNG\r\n\x1a\n") and
            pixels[12:16] == b"IHDR" and struct.unpack(">II", pixels[16:24]) == size and
            hashlib.sha256(pixels).digest() == expected_hash)


def main():
    gold = json.loads((FIXTURES / "facade-sheet-review.gold.json").read_text())
    pdf = FIXTURES / gold["fixture"]
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != gold["sha256"]:
        raise ValueError("Изменился исходный PDF")
    fact = next(item for item in gold["requiredFacts"] if item["source"] == "raster")
    page, box = fact["page"], fact["region"]
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    with tempfile.TemporaryDirectory() as temp:
        scratch = Path(temp)
        pixels = render(pdf, page, box, width, scratch)
        expected_hash = hashlib.sha256(pixels).digest()
        cases = [
            ("исходный фрагмент", serialize_image(pixels), True),
            ("другая страница", serialize_image(render(pdf, page - 1, box, width, scratch)), False),
            ("соседний участок", serialize_image(render(pdf, page, [0, top, width, bottom], width, scratch)), False),
            ("уменьшенный фрагмент", serialize_image(render(pdf, page, box, width // 2, scratch)), False),
            ("только текст с ID", json.dumps({"parts": [{"type": "text", "text": "crop-p2"}]}), False),
        ]
        for label, wire, expected in cases:
            if inspect_image(wire, expected_hash, (width, height)) != expected:
                raise ValueError(label)
            print(f"{label}: OK")


if __name__ == "__main__":
    main()

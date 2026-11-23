"""Локальный контроль OCR синтетического PDF. На входе только оригинал."""

import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

original = Path(__file__).with_name("facade-sheet-review.pdf")
with TemporaryDirectory() as temp:
    root = Path(temp).resolve()
    subprocess.run(["pdftoppm", "-r", "180", "-png", str(original), str(root / "page")], check=True)
    for path in sorted(root.glob("page-*.png")):
        page = int(path.stem.split("-")[-1])
        with Image.open(path) as sheet:
            width, height = sheet.size
            for row in range(2):
                for column in range(2):
                    left = max(0, column * (width // 2) - 60)
                    top = max(0, row * (height // 2) - 60)
                    right = min(width, (column + 1) * (width // 2) + 61)
                    bottom = min(height, (row + 1) * (height // 2) + 61)
                    region = [left, top, right, bottom]
                    tile = root / "tile.png"
                    sheet.crop(region).save(tile)
                    result = subprocess.run(
                        ["tesseract", str(tile), "stdout", "-l", "rus+eng", "--psm", "11"],
                        check=True, capture_output=True, text=True,
                    )
                    print(json.dumps({"page": page, "row": row, "column": column,
                                      "pixels": region, "text": result.stdout.strip()}, ensure_ascii=False))

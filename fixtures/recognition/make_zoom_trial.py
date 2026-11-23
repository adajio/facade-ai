"""Создать три закрытых варианта синтетического листа для проверки приближения."""
import argparse
import hashlib
import json
from pathlib import Path
import secrets

from PIL import Image, ImageDraw, ImageFont


MARKS = ("F-12", "F-17", "F-21", "F-26", "F-32", "F-38")
TARGET = "F-17"
SIZE = (2160, 1440)
OVERVIEW = (720, 480)
RNG = secrets.SystemRandom()


def sample_cell():
    return (RNG.randint(11, 98), RNG.choice(("мм", "см")), secrets.token_hex(3).upper())


def card_box(slot):
    x = 90 + 675 * (slot % 3)
    y = 240 + 545 * (slot // 3)
    return (x, y, x + 620, y + 460)


def draw_sheet(order, cells, font):
    sheet = Image.new("RGB", SIZE, "white")
    pen = ImageDraw.Draw(sheet)
    large, small = ImageFont.truetype(font, 70), ImageFont.truetype(font, 36)
    pen.text((90, 75), "Спецификация узлов фасада", fill="black", font=large)
    for slot, mark in enumerate(order):
        box = card_box(slot)
        x, y = box[:2]
        pen.rectangle(box, outline="black", width=4)
        pen.text((x + 36, y + 24), mark, font=large, fill="black")
        for offset, label in [(154, "Монтажный зазор"), (296, "Маркировка")]:
            pen.text((x + 36, y + offset), label, font=small, fill="black")
            pen.rectangle((x + 36, y + offset + 54, x + 580, y + offset + 120), fill="#dedede")
    # Стартовый вид содержит только заголовки и одинаковые плашки у всех карточек.
    overview = sheet.resize(OVERVIEW, Image.Resampling.LANCZOS)
    for slot, mark in enumerate(order):
        x, y = card_box(slot)[:2]
        value, unit, code = cells[mark]
        pen.text((x + 52, y + 214), f"{value} {unit}", font=small, fill="black")
        pen.text((x + 52, y + 356), code, font=small, fill="black")
    return sheet, overview


def write_case(folder, order, cells, font):
    sheet, overview = draw_sheet(order, cells, font)
    for name in ("reader", "input", "evaluator"):
        (folder / name).mkdir(parents=True)
    original = folder / "reader/sheet.png"
    entry = folder / "input/overview.png"
    sheet.save(original)
    overview.save(entry)
    value, unit, code = cells[TARGET]
    gold = {
        "mark": TARGET, "value": value, "unit": unit, "code": code,
        "targetBox": card_box(order.index(TARGET)), "sourceSize": SIZE, "overviewSize": OVERVIEW,
        "coordinates": "source pixels from top left; [left, top, right, bottom]",
        "sourceSha256": hashlib.sha256(original.read_bytes()).hexdigest(),
        "overviewSha256": hashlib.sha256(entry.read_bytes()).hexdigest(),
    }
    (folder / "evaluator/gold.json").write_text(json.dumps(gold, ensure_ascii=False, indent=2) + "\n")
    return gold


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, help="Новый каталог испытателя")
    parser.add_argument("--font", help="Путь к TTF-шрифту с кириллицей")
    parser.add_argument("--ambiguous-target", action="store_true",
                        help="Включить в маркировку цели глиф, общий для кириллицы и латиницы")
    args = parser.parse_args()
    font = args.font or next((str(path) for path in (
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    ) if path.is_file()), None)
    if not font:
        parser.error("Укажите --font с кириллическим TTF-шрифтом")
    args.out.mkdir(mode=0o700, exist_ok=False)
    order = list(MARKS)
    RNG.shuffle(order)
    cells = {mark: sample_cell() for mark in order}
    if args.ambiguous_target:
        value, unit, _ = cells[TARGET]
        symbols = [RNG.choice("0123456789") for _ in range(6)]
        symbols[RNG.randrange(6)] = RNG.choice("ABCE")
        cells[TARGET] = value, unit, "".join(symbols)
    baseline = write_case(args.out / "original", order, cells, font)
    moved = order.copy()
    first = moved.index(TARGET)
    other = RNG.choice([i for i in range(len(moved)) if i != first])
    moved[first], moved[other] = moved[other], moved[first]
    shifted = write_case(args.out / "moved", moved, cells, font)
    # Отдельный источник инъекции. На месте цели лежит чужая карточка.
    box = baseline["targetBox"]
    with Image.open(args.out / "original/reader/sheet.png") as clean:
        with Image.open(args.out / "moved/reader/sheet.png") as shifted_sheet:
            clean.paste(shifted_sheet.crop(box), box)
        clean.save(args.out / "foreign-injection.png")

    value, unit, code = cells[TARGET]
    next_value = RNG.choice([v for v in range(11, 99) if v != value])
    next_code = secrets.token_hex(3).upper()
    while next_code == code:
        next_code = secrets.token_hex(3).upper()
    cells[TARGET] = (next_value, "см" if unit == "мм" else "мм", next_code)
    replaced = write_case(args.out / "changed", order, cells, font)
    if (baseline["overviewSha256"] != replaced["overviewSha256"] or
            baseline["sourceSha256"] == replaced["sourceSha256"] or
            baseline["targetBox"] == shifted["targetBox"] or
            baseline["overviewSha256"] == shifted["overviewSha256"]):
        raise ValueError("Нарушены условия сравнения вариантов")
    print("Три варианта готовы. Геометрия и совпадение обзоров при смене ответа проверены.")


if __name__ == "__main__":
    main()

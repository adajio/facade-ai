"""Run a synthetic two-facade review through ordinary upload with local adapters."""

import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re

from .package_reading import PackageReading
from .source_relations import revision_of


MODELS = ("model-A", "model-B")
PROJECT = "two-facades"
ENGINEER = "Синтетический инженер"
FIRST_BATCH = {
    "A-register.txt": "Реестр передачи R3. Фасад А\n"
    "Монтажные узлы\tМонтажные узлы будут переданы отдельно.\n",
    "A-specification.txt": "Спецификация R2. Фасад А\n"
    "AL-01\tТолщина листа облицовки 2 мм.\n",
    "A-requirements.txt": "Действующее задание R1. Фасад А\n"
    "Габарит обшивки по нормали\tАлюминиевый лист исполнения 01: 0,003 м.\n"
    "Габарит обшивки по нормали\tАлюминиевый лист исполнения 02: 0,004 м.\n",
    "B-specification.txt": "Спецификация R1. Фасад Б\n"
    "AL-01\tТолщина листа облицовки 3 мм.\n",
    "B-details.txt": "Детали примыканий R1. Фасад Б\n"
    "Установочные узлы\tКрепление стойки в оси Б2, опора и анкер.\n",
}
SUPPLEMENT = {
    "supplement-sheet-07.txt": "Детали примыканий R1. Фасад А\n"
    "Установочные узлы\tКрепление стойки в оси А1, опора и анкер.\n",
}


def question_profile():
    """The fixture's approved scope, document roles, and vocabulary."""
    details = {
        "subject": "установочные узлы",
        "aliases": ["Монтажные узлы", "Установочные узлы"],
        "required_roles": ["details"],
        "authority_role": "register",
        "external": True,
    }
    sources = {
        "A-register.txt": ("facade-a", "register"),
        "A-specification.txt": ("facade-a", "spec"),
        "A-requirements.txt": ("facade-a", "requirements"),
        "B-specification.txt": ("facade-b", "spec"),
        "B-details.txt": ("facade-b", "details"),
    }
    return {
        "documents": {
            source: {
                "scope": scope,
                "role": role,
                "sha256": hashlib.sha256(FIRST_BATCH[source].encode("utf-8")).hexdigest(),
            }
            for source, (scope, role) in sources.items()
        },
        "questions": [
            {
                **details,
                "id": "a-details",
                "scope": "facade-a",
                "request_text": "Просим направить установочные узлы фасада А.",
            },
            {
                "id": "a-thickness",
                "scope": "facade-a",
                "subject": "толщина листа облицовки AL-01",
                "aliases": ["AL-01"],
                "required_roles": ["spec", "requirements"],
                "external": True,
                "request_text": "Просим уточнить действующую толщину листа AL-01 фасада А.",
            },
            {
                "id": "b-specification",
                "scope": "facade-b",
                "subject": "спецификация листа AL-01",
                "aliases": ["AL-01"],
                "required_roles": ["spec"],
                "external": True,
                "request_text": "Просим направить спецификацию листа AL-01 фасада Б.",
            },
            {
                **details,
                "id": "b-details",
                "scope": "facade-b",
                "request_text": "Просим направить установочные узлы фасада Б.",
            },
        ],
    }


def write_originals(folder, originals):
    folder.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, body in originals.items():
        files[name] = folder / name
        files[name].write_bytes(body.encode("utf-8"))
    return files


def read_sheets(files, expected):
    units, owners, metadata = {}, {}, {}
    for name, path in files.items():
        unit = f"{name}/page-1"
        lines = path.read_text(encoding="utf-8").splitlines()
        units[unit], owners[unit] = lines, expected[name]
        # The fixture reader recognizes the title block of a newly arrived sheet.
        if lines[:1] == ["Детали примыканий R1. Фасад А"]:
            metadata[name] = {"sha256": expected[name], "scope": "facade-a", "role": "details"}
    return units, owners, metadata


def extract_rows(job, rows):
    receipt = f"synthetic/{job['model']}/{job['job']}"
    observations = []
    for number, row in rows.items():
        label, tab, text = row.partition("\t")
        if tab:
            observations.append(
                {"label": label, "text": text, "lines": [number],
                 "role": "data", "receipt": receipt}
            )
    return {"state": "read", "observations": observations, "receipt": receipt}


def _matches_execution(fact, execution):
    if execution is None or fact["label"] == execution[0]:
        return True
    return fact["label"] == "Габарит обшивки по нормали" and any(
        re.search(rf"\bалюминиевый лист исполнения {execution[1]}\b", line, re.IGNORECASE)
        for line in fact["original_lines"]
    )


def _review(question, facts):
    execution = re.search(r"\bAL-(\d+)\b", question["subject"])
    by_role = {
        fact["document_role"]: fact
        for fact in facts
        if fact["role"] == "data" and _matches_execution(fact, execution)
    }
    required = question["required_roles"]
    missing = [role for role in required if role not in by_role]
    if missing:
        register = by_role.get(question.get("authority_role"))
        if register:
            for line in register["original_lines"]:
                statement = line.partition("\t")[2]
                if statement.endswith("будут переданы отдельно."):
                    return {
                        "status": "missing",
                        "basis": [register["id"]],
                        "reason": statement,
                        "missing_roles": missing,
                        "attestation": {"fact": register["id"], "quote": statement},
                    }
        return {"status": "needs_review", "basis": [fact["id"] for fact in facts],
                "reason": "Обязательное содержание и его отсутствие пока не установлены."}

    selected = [by_role[role] for role in required]
    basis = [fact["id"] for fact in selected]
    values, opposed = [], []
    for fact in selected:
        measurement = re.search(r"(\d+(?:,\d+)?) (мм|м)\b", "\n".join(fact["original_lines"]))
        if measurement:
            number, unit = measurement.groups()
            millimeters = Decimal(number.replace(",", ".")) * (1000 if unit == "м" else 1)
            values.append(millimeters.normalize())
            opposed.append({"fact": fact["id"], "quote": measurement[0]})
    if len(values) == 2 and values[0] != values[1]:
        return {"status": "conflict", "basis": basis, "opposed": opposed,
                "reason": f"Указаны несовместимые значения {values[0]:g} и {values[1]:g} мм."}
    return {"status": "covered", "basis": basis,
            "reason": "Прочитаны адресные сведения по обязательным ролям."}


def compare_question(case):
    """A deterministic stand-in for two reviewers reading their addressed sources."""
    if case["kind"] != "engineering_question":
        raise ValueError("the approved profile only admits engineering questions")
    return {
        "reviews": {
            model: _review(case["question"], [f for f in case["facts"] if f["model"] == model])
            for model in MODELS
        }
    }


def make_reader(*, compare=compare_question, extract=extract_rows, profile=None):
    return PackageReading(
        reader=read_sheets,
        models=MODELS,
        extract=extract,
        compare=compare,
        gateway_available=lambda: True,
        publish=lambda _revision, cases, _issues: cases,
        question_profile=question_profile() if profile is None else profile,
        project_id=PROJECT,
        workers=1,
    )


def submit(reader, files, state):
    expected = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    reader.upload(files, expected, state)
    return state / "engineering" / revision_of(expected) / "assessment.json"


def confirm_letter(reader, state, assessment):
    return reader.confirm(
        state,
        assessment["assessment_id"],
        [item["question_id"] for item in assessment["letter"]],
        ENGINEER,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new directory for the originals and review artifacts")
    output = parser.parse_args().output.resolve()
    output.mkdir(parents=True)
    state = output / "state"
    compared = []

    def compare(case):
        compared.append(case)
        return compare_question(case)

    first = write_originals(output / "01-originals", FIRST_BATCH)
    additional = write_originals(output / "02-supplement", SUPPLEMENT)
    reader = make_reader(compare=compare)
    deliveries = (
        ("Первое поступление", first, "letter-before.txt"),
        ("После досылки узлов фасада А", additional, "letter-after.txt"),
    )
    for label, files, filename in deliveries:
        path = submit(reader, files, state)
        assessment = json.loads(path.read_bytes())
        confirmed = confirm_letter(reader, state, assessment)
        letter = output / filename
        letter.write_text(confirmed["text"], encoding="utf-8")
        print(f"\n{label}")
        print(path)
        for question in assessment["questions"]:
            print(f"  {question['id']} — {question['status']}")
        print(f"  Письмо по выбору синтетического инженера\n  {letter}")
        print(confirmed["text"])

    (output / "comparison-inputs.json").write_text(
        json.dumps(compared, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()

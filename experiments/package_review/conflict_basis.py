"""Verify which two current source statements make a conflict material."""

import re
from decimal import Decimal

from .engineering_questions import quoted_value

VERIFY_CONFLICT = """
Выясни только одно: утверждают ли два одновременно применимых оригинала
несовместимые значения одного свойства, объекта и исполнения. Проверь замену,
иерархию, единицы и область; отсутствие приоритета само по себе не противоречие.
Каждой стороне назначь ОДНУ цитату с дословным значением из оригинала
(включая единицу, если она в строке). Не бери заголовок, номер редакции или
произвольное число. Для conflict добавь поле conflict_basis со структурой
{"sides":[{"pin":1,"value":"…"},{"pin":2,"value":"…"}],"applicability":[3]}.
pin и applicability — номера цитат в evidence с 1. В applicability приведи
места, подтверждающие одновременную применимость; ими могут служить и сами
сопоставляемые строки. Добавь в evidence существенные ограничения и исключения.
Если применимость или значения не установлены, верни needs_review с объяснением
и request=null. Открывай дополнительные оригиналы по необходимости."""


def value_key(text):
    family, value = quoted_value(text)
    if family == "length":
        return family, value
    match = re.fullmatch(r"([+-]?\d+(?:[.,]\d+)?)\s*([^\d\s]*)", text.strip())
    if match:
        if not match[2]:
            raise ValueError(
                "include the printed unit; bare numbers cannot resolve this conflict"
            )
        return "number:" + match[2].casefold(), Decimal(match[1].replace(",", "."))
    if re.search(r"\d", text):
        raise ValueError("compound numeric values require engineering review")
    return family, value


def whole_value(value, quote):
    # A substring such as '5 мм' inside '15 мм' or '5 мм' after a decimal
    # separator isn't a source reading of the value 5.
    return (
        re.search(r"(?<![\w.,+−-])" + re.escape(value) + r"(?![\w/^])", quote)
        is not None
    )


def sides(row, owners, originals=None):
    basis = row.get("conflict_basis")
    if not isinstance(basis, dict):
        raise TypeError("give two opposed source values and applicability pins")
    evidence = row["evidence"]

    def citation(pin):
        if type(pin) is not int or not 1 <= pin <= len(evidence):
            raise ValueError("pin must address a delivered citation")
        return evidence[pin - 1]

    context = basis.get("applicability")
    if not isinstance(context, list) or not context:
        raise ValueError("cite what makes both originals applicable together")
    for pin in context:
        citation(pin)
    opposed = basis.get("sides")
    if not isinstance(opposed, list) or len(opposed) != 2:
        raise ValueError("give exactly two opposed values")
    bindings = {}
    sources = set()
    qualifiers = set()
    for item in opposed:
        if not isinstance(item, dict):
            raise TypeError("invalid opposed value")
        e = citation(item.get("pin"))
        value = item.get("value")
        if (
            not isinstance(value, str)
            or not value.strip()
            or not whole_value(value, e["quote"])
            or (
                originals is not None
                and not whole_value(value, originals[e["unit"]][e["line"] - 1])
            )
        ):
            raise ValueError("value must be a verbatim part of the cited line")
        # Writers may copy a measurement together with its condition. Strip
        # only the identical verbatim suffix on BOTH sides within this reading.
        measurement = re.fullmatch(
            r"([+-]?\d+(?:[.,]\d+)?\s*(?:мм|см|м|mm|cm|m))\s+([^\W\d_]+(?:[ -][^\W\d_]+)*)",
            value,
            re.IGNORECASE,
        )
        qualifiers.add(measurement[2].casefold() if measurement else "")
        bindings[e["unit"], e["line"]] = value_key(
            measurement[1] if measurement else value
        )
        sources.add(owners[e["unit"]])
    if (
        len(qualifiers) != 1
        or len(sources) != 2
        or len(set(bindings.values())) != 2
        or len({family for family, _ in bindings.values()}) != 1
    ):
        raise ValueError("two distinct originals and incompatible values are required")
    return bindings

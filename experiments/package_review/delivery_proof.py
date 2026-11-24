"""Admit a non-delivery claim only after an addressed inquiry about the delivery itself."""

from .engineering_questions import contains_term

INQUIRY = """
Проверь по оригиналам, что установлено о передаче конкретного обязательного
материала или сведения для этой области и стадии. Отдели факт передачи от
состояния содержания. Открывай при необходимости остальные единицы через open.
Ты не видишь чужих выводов. Прочитай возможные досылки, комплектовочную запись,
ревизию и признаки опровержения. Отсутствие найденного числа, пустая ячейка,
трудность чтения, незавершённый подбор, рекомендация изготовить лист или
молчание описи сами по себе не доказывают непередачу.
В каждый answers добавь delivery: {"kind":"document|information",
"target":"конкретный предмет возможного запроса", "state":
"not_delivered|received_unreadable|value_unresolved|received|unknown",
"attestation":null, "object_quote":null}. Для not_delivered нужна положительная запись применимого
источника о составе текущей поставки, явно устанавливающая непередачу именно
этого предмета (в том числе обязательного сведения отдельно от приложенного
документа). В attestation поставь индекс этой дословной цитаты в evidence с 1,
включи его в decisive. В object_quote помести дословное обозначение этого
предмета из той же строки или из её адресного контекста в evidence; в reason объясни область, обязанность, актуальность,
почему исходная запись авторитетна и почему досылка её не закрыла. Статус
missing и узкий запрос только по этому предмету. Для остальных состояний
needs_review с цитатами, attestation и request равны null. В reason укажи, что
уже получено и что нельзя установить по нему. Дай ровно один JSON answers."""


def validate_delivery(row):
    fact = row.get("delivery")
    if not isinstance(fact, dict) or fact.get("kind") not in (
        "document",
        "information",
    ):
        raise ValueError("identify the delivery target kind (document or information)")
    if not isinstance(fact.get("target"), str) or not fact["target"].strip():
        raise ValueError("name the specific required delivery target")
    if fact.get("state") == "not_delivered":
        target = fact.get("object_quote")
        if (
            not isinstance(target, str)
            or not target.strip()
            or not any(target in e["quote"] for e in row["evidence"])
        ):
            raise ValueError("give the verbatim target of non-delivery in object_quote")
        pin = fact.get("attestation")
        if (
            row["status"] != "missing"
            or type(pin) is not int
            or pin not in row["decisive"]
        ):
            raise ValueError(
                "non-delivery requires its direct attestation among decisive citations"
            )
    elif (
        fact.get("state")
        not in ("received_unreadable", "value_unresolved", "received", "unknown")
        or row["status"] != "needs_review"
        or fact.get("attestation") is not None
    ):
        raise ValueError(
            "unproven delivery requires needs_review without an attestation"
        )


def common_attestation(rows):
    if not all(row and row["status"] == "missing" for row in rows):
        return False
    left, right = rows
    a, b = [row["evidence"][row["delivery"]["attestation"] - 1] for row in rows]
    target_a, target_b = (row["delivery"]["object_quote"].casefold() for row in rows)
    if left["delivery"]["kind"] != right["delivery"]["kind"] or not (
        contains_term(target_b, target_a) or contains_term(target_a, target_b)
    ):
        return False

    def endorses(row, citation):
        return any(
            e["unit"] == citation["unit"]
            and e["line"] == citation["line"]
            and (e["quote"] in citation["quote"] or citation["quote"] in e["quote"])
            for e in (row["evidence"][n - 1] for n in row["decisive"])
        )

    # A single scoped receipt can state what was deferred on one line and
    # record the delivery cut-off on another. Both must endorse BOTH lines.
    return a["unit"] == b["unit"] and endorses(left, b) and endorses(right, a)

"""Apply a visual zoom answer only to evidence verified by the harness."""

import re
from collections.abc import Mapping
from typing import Literal


def evaluate_evidence(
    answer: Mapping[str, object],
    *,
    alphabet: Literal["ascii_hex"] | None,
    source_status: Literal["verified", "missing", "mismatch", "unassessed"],
    requested_mark: str = "F-17",
) -> dict[str, object]:
    """Keep only observations supported by the verified crop and field catalog.

    Source status comes from the recorded image and address, never from the
    model answer. This experiment cannot establish absence from the sheet.
    """
    raw_code = answer.get("code")
    glyph_pairs = ("AА", "BВ", "CС", "EЕ")
    result: dict[str, object] = {
        "status": "needs_evidence",
        "reason": "",
        "absence_supported": False,
        "code_raw": raw_code if isinstance(raw_code, str) else None,
        "code_status": "unverified_source",
        "ambiguous_glyphs": [],
        "applied": None,
    }
    if source_status != "verified":
        result["reason"] = {
            "missing": "source_missing",
            "mismatch": "source_mismatch",
        }.get(source_status, "source_unverified")
        return result

    answer_status = answer.get("status")
    if answer_status not in ("found", "partial"):
        result["reason"] = "absence_unsupported" if answer_status == "absent" else "observation_unconfirmed"
        return result

    if answer.get("mark") != requested_mark:
        result["reason"] = "mark_mismatch"
        return result

    value, unit = answer.get("value"), answer.get("unit")
    if type(value) is not int or not isinstance(unit, str) or unit not in ("мм", "см"):
        result["reason"] = "invalid_measurement"
        return result

    code: str | None = None
    if raw_code is None or raw_code == "":
        code_status, reason = "missing", "code_missing"
    elif not isinstance(raw_code, str):
        code_status, reason = "invalid", "code_invalid"
    elif alphabet is None:
        alternatives = [{"index": index, "latin": pair[0], "cyrillic": pair[1]}
                        for index, glyph in enumerate(raw_code) for pair in glyph_pairs if glyph in pair]
        result["ambiguous_glyphs"] = alternatives
        if alternatives:
            code_status, reason = "ambiguous", "code_alphabet_ambiguous"
        else:
            code_status, reason = "unconfirmed_alphabet", "code_alphabet_unknown"
    elif alphabet == "ascii_hex" and re.fullmatch(r"[0-9A-F]{6}", raw_code):
        code_status, reason, code = "verified", None, raw_code
    else:
        code_status, reason = "invalid", "code_invalid"

    result.update(
        status="supported" if code is not None else "partial",
        reason=reason,
        code_status=code_status,
        applied={"mark": requested_mark, "value": value, "unit": unit, "code": code},
    )
    return result

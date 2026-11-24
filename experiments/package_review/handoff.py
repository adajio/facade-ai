"""Import actual reader receipts and export the ledger for an engineer."""

import hashlib
import html
import json
import math
import os
import re
import tempfile
from pathlib import Path

from .research import digest


_ADDRESS_ACTIONS = {"read", "view"}
_VERDICTS = {"supported": "confirmed", "needs_evidence": "unresolved"}
_RESEARCH_RECEIPT = re.compile(r"E([1-9][0-9]*)\.[1-9][0-9]*\Z")


def _has_content(parts, *, image_only=False):
    if not isinstance(parts, list):
        return False
    for part in parts:
        if not isinstance(part, dict):
            continue
        if not image_only and part.get("type") == "text" and isinstance(part.get("text"), str) and part["text"].strip():
            return True
        image = part.get("image_url")
        url = image.get("url") if isinstance(image, dict) else None
        if part.get("type") == "image_url" and isinstance(url, str) and url.startswith("data:image/"):
            return True
    return False


def _located(ref, call):
    if call["op"] == "read":
        start = call.get("start", 0)
        if type(start) is not int or start < 0:
            raise ValueError("read start must be a nonnegative integer")
        return f"{ref}@start={start}"
    rect = call.get("rect")
    if rect is None:
        return f"{ref}@rect=full"
    if not isinstance(rect, list) or len(rect) != 4:
        raise ValueError("view rect must contain four coordinates")
    if any(type(x) not in (int, float) or not 0 <= x <= 1 or not math.isfinite(x) for x in rect):
        raise ValueError("view rect must use finite normalized coordinates")
    if rect[0] >= rect[2] or rect[1] >= rect[3]:
        raise ValueError("view rect must have a positive extent")
    canonical = json.dumps([float(x) if x else 0.0 for x in rect], separators=(",", ":"))
    return f"{ref}@rect={canonical}"


def resolve_receipts(refs, delivered, *, lane_id, source_revisions):
    """Resolve local receipts to addressed sources; keep navigation and bad inputs distinguishable."""
    sources, navigation, errors = [], [], []
    if not isinstance(refs, list):
        return sources, navigation, ["receipt references must be a list"]
    seen = set()
    for ref in refs:
        if not isinstance(ref, str) or not ref.strip():
            errors.append("receipt reference must be a nonempty string")
            continue
        if ref in seen:
            continue
        seen.add(ref)
        receipt = delivered.get(ref)
        if not isinstance(receipt, dict) or receipt.get("id") != ref or receipt.get("status") != "ok":
            errors.append(f"{ref}: no successful delivered receipt in this lane")
            continue
        call = receipt.get("call")
        if not isinstance(call, dict):
            errors.append(f"{ref}: missing issued call")
            continue
        op = call.get("op")
        if not isinstance(op, str) or not op:
            errors.append(f"{ref}: missing tool operation")
            continue
        parts = receipt.get("parts")
        checksum = receipt.get("sha256")
        if not _has_content(parts, image_only=op == "view") or digest(parts) != checksum:
            errors.append(f"{ref}: delivered content missing or its checksum differs")
            continue
        locator = call.get("ref")
        if op not in _ADDRESS_ACTIONS or (isinstance(locator, str) and ":" not in locator):
            navigation.append(ref)
            continue
        if not isinstance(locator, str):
            errors.append(f"{ref}: missing source locator")
            continue
        source_id, _, place = locator.partition(":")
        revision = source_revisions.get(source_id)
        if not place.strip() or not isinstance(revision, str) or not revision.strip():
            errors.append(f"{ref}: source locator has no acknowledged revision")
            continue
        try:
            locator = _located(locator, call)
        except ValueError as exc:
            errors.append(f"{ref}: {exc}")
            continue
        sources.append({"source_id": source_id, "source_revision": revision, "locator": locator,
                        "receipt": f"{lane_id}/{ref}@sha256:{checksum}"})
    return sources, navigation, errors


def import_frozen(store, frozen, *, package_revision, lane_id, origin, source_revisions):
    """Import one sealed research lane; IDs are stable across replays of this lane."""
    candidates, delivered = frozen["candidates"], frozen["delivered"]
    if not isinstance(candidates, list) or not isinstance(delivered, dict):
        raise ValueError("frozen lane requires a candidate list and a delivered-receipt map")
    imported = []
    for ordinal, raw in enumerate(candidates, 1):
        candidate = raw if isinstance(raw, dict) else {}
        step, item = candidate.get("step"), candidate.get("item")
        has_position = type(step) is int and type(item) is int and step > 0 and item > 0
        observation_id = f"{lane_id}:{step}.{item}" if has_position else f"{lane_id}:unlocated-{ordinal}"
        declared = candidate.get("refs", [])
        used = candidate.get("delivered_refs", [])
        if not isinstance(declared, list) or not isinstance(used, list):
            evidence = ([], [], ["candidate references must be lists"])
        else:
            sources, navigation, errors = resolve_receipts(used, delivered, lane_id=lane_id,
                                                          source_revisions=source_revisions)
            if any(not isinstance(ref, str) or ref not in used for ref in declared):
                errors.append("some declared receipts were not delivered when this observation was made")
            if any(not isinstance(ref, str) or ref not in declared for ref in used):
                errors.append("delivered_refs contain receipts the candidate did not cite")
            if has_position:
                for ref in used:
                    match = _RESEARCH_RECEIPT.fullmatch(ref) if isinstance(ref, str) else None
                    if match and int(match[1]) >= step:
                        errors.append(f"{ref}: receipt was issued after this observation's prompt")
            evidence = sources, navigation, errors
        sources, navigation, errors = evidence
        if not has_position:
            errors.append("candidate has no positive step and item")
        record = {
            "observation_id": observation_id,
            "fact_id": observation_id,
            "package_revision": package_revision,
            "statement": candidate.get("fact") if has_position else None,
            "scope": lane_id,
            "origin": origin,
            "sources": sources if not errors else [],
            "reader_trace": {"lane_id": lane_id, "step": step, "item": item, "declared_refs": declared,
                             "navigation_refs": navigation, "problems": errors, "located_sources": sources},
        }
        if "quote" in candidate:
            record["quote"] = candidate["quote"]
        result = store.record_observation(record)
        imported.append({"observation_id": observation_id, "candidate": raw, "sources": record["sources"],
                         "problems": errors, "result": result})
    return imported


def import_review(store, verdict, *, reviewer, review_id, delivered, lane_id, source_revisions):
    """Import an independent semantic verdict using this reviewer's actual delivered places."""
    if not isinstance(verdict, dict):
        return store.record_review({"review_id": review_id, "reviewer": reviewer, "raw_verdict": verdict})
    refs = verdict.get("delivered_refs", [])
    sources, navigation, errors = resolve_receipts(refs, delivered, lane_id=lane_id, source_revisions=source_revisions)
    action = verdict.get("verdict")
    action = _VERDICTS.get(action, action) if isinstance(action, str) else action
    record = {"review_id": review_id, "observation_id": verdict.get("observation_id"), "reviewer": reviewer,
              "verdict": action, "rationale": verdict.get("rationale"), "sources": sources if not errors else [],
              "reader_trace": {"lane_id": lane_id, "refs": refs, "navigation_refs": navigation, "problems": errors}}
    if "supersedes" in verdict:
        record["supersedes"] = verdict["supersedes"]
    return store.record_review(record)


def _literal(value):
    return re.sub(r"([\\`*_{}\[\]()#+!|~])", r"\\\1", html.escape(str(value)))


def _quoted(value):
    return [f"> {_literal(line)}" for line in str(value).splitlines()] or ["> "]


def _source_lines(sources):
    return [f"- {_literal(s['source_id'])}, {_literal(s['source_revision'])}, {_literal(s['locator'])}, "
            f"квитанция {_literal(s['receipt'])}" for s in sources]


def _fact_lines(fact):
    result = ["", f"### {_literal(fact['observation_id'])} · {_literal(fact['status'])}",
              "", f"Область — {_literal(fact['scope'])}. Автор наблюдения — {_literal(fact['origin'])}.", "",
              *_quoted(fact["statement"]), "", *_source_lines(fact["sources"])]
    if fact.get("derived_from"):
        result.extend(["", f"Выделено из наблюдения {_literal(fact['derived_from'])}."])
    for review in fact["reviews"]:
        result.extend(["", f"Проверка {_literal(review['review_id'])} · {_literal(review['reviewer'])} · "
                       f"{_literal(review['verdict'])}", "", *_quoted(review["rationale"]), "",
                       *_source_lines(review["sources"])])
    return result


def render_engineer_markdown(snapshot):
    """Render the complete observation register followed by separate external-request sections."""
    lines = ["# Реестр наблюдений для инженера", "", f"Редакция пакета — {_literal(snapshot['package_revision'])}."]
    if snapshot["summary"] is not None:
        lines.extend(["", "## Краткая справка", "", *_quoted(snapshot["summary"])])
    for key, title in (("confirmed_facts", "Подтверждённые наблюдения"), ("open_facts", "Незакрытые и отклонённые наблюдения")):
        facts = snapshot[key]
        lines.extend(["", f"## {title}", "", f"Всего — {len(facts)}."])
        for fact in facts:
            lines.extend(_fact_lines(fact))
    lines.extend(["", "## Неутверждённые предложения для внешнего запроса"])
    if not snapshot["letter_recommendations"]:
        lines.extend(["", "Предложений нет."])
    for row in snapshot["letter_recommendations"]:
        ids = ", ".join(_literal(item) for item in row["basis_observation_ids"])
        lines.extend(["", f"### {_literal(row['recommendation_id'])}", "", *_quoted(row["text"]), "",
                      f"Идентификаторы оснований — {ids}."])
    approved = snapshot["approved_letter"]
    lines.extend(["", "## Утверждённые пункты письма", "", f"Всего — {len(approved['items'])}."])
    if approved["decision"]:
        decision = approved["decision"]
        lines.extend(["", f"Решение {_literal(decision['decision_id'])} · {_literal(approved['status'])} · "
                      f"{_literal(decision['engineer'])}."])
    for item in approved["items"]:
        lines.extend(["", f"### {_literal(item['recommendation_id'])}", "", *_quoted(item["text"])])
    invalid = snapshot.get("invalid_records", [])
    if invalid:
        lines.extend(["", "## Записи в карантине", ""])
        lines.extend(f"- {row['seq']} · {_literal(row['kind'])} · {_literal(row['reason'])}" for row in invalid)
    return "\n".join(lines) + "\n"


def _replace(path, payload):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def write_engineer_export(store, directory, *, package_revision, summary=None):
    """Write the JSON snapshot and a readable rendering, then return that snapshot."""
    snapshot = store.export_engineer(package_revision, summary)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = (json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8", "backslashreplace")
    checksum = hashlib.sha256(payload).hexdigest()
    markdown = render_engineer_markdown(snapshot) + f"\nСнимок facts.json · SHA-256 `{checksum}`\n"
    _replace(directory / "реестр.md", markdown.encode("utf-8"))
    _replace(directory / "facts.json", payload)
    return snapshot

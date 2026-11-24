"""Build a compact peer review from actually presented evidence and retain unanswered items."""

import json
import re


def _wire(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def compact_input(items, material):
    """items contain observation_id, statement and local receipt IDs from this review session."""
    rows = []
    for ordinal, item in enumerate(items, 1):
        refs = item["refs"]
        if not refs or any(ref not in material or material[ref]["status"] != "ok" for ref in refs):
            raise ValueError("each item requires delivered source material")
        rows.append([str(ordinal), item["statement"], refs])
    if len({item["observation_id"] for item in items}) != len(items):
        raise ValueError("duplicate observation ID")
    result = [{"type": "text", "text": _wire(rows)}]
    for ref, receipt in material.items():
        result.append({"type": "text", "text": ref + " " + _wire(receipt["call"])})
        result.extend(receipt["parts"])
    return result


def read_verdicts(items, raw):
    """Use only explicit verdicts. Duplicate conflicting answers stay open."""
    result, inconsistent = {}, set()
    actions = {"C": "confirmed", "R": "rejected", "U": "unresolved"}
    for line in raw.splitlines():
        match = re.fullmatch(r"\s*(\d+)\s+([CRU])\s*[:—-]\s*(\S.*)", line.strip())
        if not match:
            continue
        index = int(match[1]) - 1
        if not 0 <= index < len(items):
            continue
        item = items[index]
        key = item["observation_id"]
        review = {"observation_id": key, "verdict": actions[match[2]],
                  "rationale": match[3], "delivered_refs": item["refs"]}
        if key in result and result[key] != review:
            inconsistent.add(key)
        result[key] = review
    for key in inconsistent:
        result.pop(key)
    pending = [item["observation_id"] for item in items if item["observation_id"] not in result]
    return list(result.values()), pending

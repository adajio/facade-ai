"""Recover complete observations from a provider response truncated inside its JSON envelope."""

import json


def complete_observations(text):
    """Read a prefix of an observations array. Never repair a string or execute a partial call."""
    text = text.strip()
    if text.startswith("```"):
        text = text.partition("\n")[2].lstrip()
    decoder = json.JSONDecoder()
    if not text.startswith("{"):
        return []
    tail = text[1:].lstrip()
    try:
        while tail:
            field, end = decoder.raw_decode(tail)
            tail = tail[end:].lstrip()
            if not isinstance(field, str) or not tail.startswith(":"):
                return []
            tail = tail[1:].lstrip()
            if field == "observations":
                break
            _, end = decoder.raw_decode(tail)
            tail = tail[end:].lstrip()
            if not tail.startswith(","):
                return []
            tail = tail[1:].lstrip()
    except ValueError:
        return []
    if not tail.startswith("["):
        return []
    tail = tail[1:].lstrip()
    items = []
    while tail:
        try:
            item, end = decoder.raw_decode(tail)
        except ValueError:
            break
        if isinstance(item, dict) and isinstance(item.get("fact"), str) and item["fact"].strip():
            items.append(item)
        tail = tail[end:].lstrip()
        if not tail.startswith(","):
            break
        tail = tail[1:].lstrip()
    return items


def reconcile_truncated(snapshot, response_for_step):
    """Return a derived snapshot without changing the original freeze or executing recovered calls.

    response_for_step loads a persisted (finish_reason, text) pair for an
    accepted response. Receipt IDs are lane-local; E<n> results first reach
    the model on turn n+1. Keep this separately attributable from normal output.
    """
    restored = []
    occupied = {(item["step"], item["item"]) for item in snapshot["candidates"]}
    delivered = snapshot["delivered"]
    for turn in snapshot["history"]:
        if "unparsed" not in turn["issues"]:
            continue
        step = turn["step"]
        reason, text = response_for_step(step)
        if reason != "length":
            continue
        for item, fact in enumerate(complete_observations(text), 1):
            if (step, item) in occupied:
                continue
            refs = fact.get("refs", [])
            refs = refs if isinstance(refs, list) else [refs]
            available = [ref for ref in refs if isinstance(ref, str) and ref in delivered
                         and delivered[ref]["status"] == "ok"
                         and int(ref[1:].split(".")[0]) < step]
            restored.append({**fact, "refs": refs, "delivered_refs": available, "step": step,
                             "item": item, "recovered_complete_item": True})
    candidates = sorted(snapshot["candidates"] + restored, key=lambda item: (item["step"], item["item"]))
    return {**snapshot, "candidates": candidates}, len(restored)

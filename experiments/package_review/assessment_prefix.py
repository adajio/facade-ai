"""Extract finished evidence fields from an interrupted comparison, without completing its verdict."""

import json


def recover_reading(text, finish_reason, allowed_lines):
    """Return traceable source/entry records from a length-limited object prefix.

    Only finished top-level array elements count. Nested keys, model actions and proposed
    conclusions are ignored. A partial assessment can request further inspection.
    """
    result = {"sources": [], "entries": [], "comparison_requested": False, "complete": False}
    if finish_reason != "length" or not isinstance(text, str):
        return result
    text = text.lstrip()
    if text.startswith("```"):
        text = text.partition("\n")[2].lstrip()
    if not text.startswith("{"):
        return result
    decoder = json.JSONDecoder()
    tail = text[1:].lstrip()
    seen = set()
    decision = None
    try:
        while tail:
            key, end = decoder.raw_decode(tail)
            tail = tail[end:].lstrip()
            if not isinstance(key, str) or key in seen or not tail.startswith(":"):
                break
            seen.add(key)
            tail = tail[1:].lstrip()
            if key in {"sources", "entries"} and tail.startswith("["):
                tail = tail[1:].lstrip()
                while tail and not tail.startswith("]"):
                    value, end = decoder.raw_decode(tail)
                    tail = tail[end:].lstrip()
                    if not tail.startswith((",", "]")) and tail:
                        return result
                    if isinstance(value, dict):
                        ref, lines = value.get("ref"), value.get("lines")
                        field = "reading" if key == "sources" else "label"
                        if (isinstance(ref, str) and ref in allowed_lines
                                and isinstance(lines, list) and lines
                                and all(type(i) is int and i in allowed_lines[ref] for i in lines)
                                and isinstance(value.get(field), str) and value[field].strip()):
                            result[key].append(value)
                    if not tail.startswith(","):
                        break
                    tail = tail[1:].lstrip()
                if not tail.startswith("]"):
                    break
                tail = tail[1:].lstrip()
            else:
                value, end = decoder.raw_decode(tail)
                tail = tail[end:].lstrip()
                if key == "decision":
                    decision = value
            if not tail.startswith(","):
                break
            tail = tail[1:].lstrip()
    except ValueError:
        pass
    result["comparison_requested"] = (decision == "compared" and len(allowed_lines) >= 2
                                      and set(allowed_lines) == {r["ref"] for r in result["sources"]})
    return result

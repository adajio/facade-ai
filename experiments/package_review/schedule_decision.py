"""Check the numbers in a schedule comparison separately from applicability and letter approval."""


def source_counts(source):
    rows = source.get("rows")
    if not isinstance(rows, list) or not rows:
        return None
    counts = {}
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            return None
        mark, anchor, quantity = row.get("mark"), row.get("anchor"), row.get("qty")
        if not isinstance(mark, str) or not mark.strip() or type(anchor) is not int or anchor < 0:
            return None
        if type(quantity) is not int or quantity < 0 or (mark, anchor) in seen:
            return None
        seen.add((mark, anchor))
        counts[mark] = counts.get(mark, 0) + quantity
    subtotal = source.get("total")
    if type(subtotal) is not int or subtotal != sum(counts.values()):
        return None
    return counts


def numeric_comparison(answer, expected_sources, supporting_sources=()):
    """Accept only complete addressed source pairs. Equal totals can hide differing variants."""
    rows = answer.get("sources", []) if isinstance(answer, dict) else []
    expected = set(expected_sources)
    supporting = set(supporting_sources) - expected
    result = {}
    if not isinstance(rows, list):
        return {}
    for source in rows:
        if not isinstance(source, dict):
            return {}
        ref = source.get("ref")
        if isinstance(ref, str) and ref in supporting and source.get("rows") == [] and source.get("total") is None:
            continue
        if not isinstance(ref, str) or ref not in expected or ref in result:
            return {}
        counts = source_counts(source)
        if counts is None:
            return {}
        result[ref] = counts
    return result if len(result) >= 2 and result.keys() == expected else {}


def compare_readers(first, second, expected_sources, supporting_sources=()):
    a, b = [numeric_comparison(x, expected_sources, supporting_sources) for x in (first, second)]
    if not a or not b:
        return "needs_source_review"
    return "counts_agree" if a == b else "disputed_counts"


def locate_mark(mark, anchor, lines, radius=3):
    """Return a suggested nearby line for review; preserve the submitted anchor with the result."""
    import re
    if not isinstance(mark, str) or not mark.strip() or type(anchor) is not int or not 0 <= anchor < len(lines):
        return {"submitted": anchor, "line": None, "status": "invalid"}
    pattern = re.compile(r"(?<![\w.*-])" + re.escape(mark.strip()) + r"(?![\w.*-])", re.I)
    if pattern.search(lines[anchor]):
        return {"submitted": anchor, "line": anchor, "status": "exact"}
    candidates = [i for i in range(max(0, anchor-radius), min(len(lines), anchor+radius+1))
                  if pattern.search(lines[i])]
    if len(candidates) == 1:
        return {"submitted": anchor, "line": candidates[0], "status": "suggested"}
    return {"submitted": anchor, "line": None, "status": "ambiguous" if candidates else "unlocated"}


def dimension_disputes(answers):
    """Detect competing two-axis dimensions for the same source and literal mark."""
    import re
    from collections import defaultdict
    places = defaultdict(set)
    for answer in answers:
        for source in answer.get("sources", []):
            for row in source.get("rows", []):
                dims = re.findall(r"(\d+(?:[.,]\d+)?)\s*[xх×]\s*(\d+(?:[.,]\d+)?)",
                                  str(row.get("size", "")), flags=re.I)
                if len(dims) == 1 and row.get("mark") and source.get("ref"):
                    places[(source["ref"], row["mark"])].add(tuple(n.replace(",", ".") for n in dims[0]))
    return {place: sorted(values) for place, values in places.items() if len(values) > 1}


def review_measured_field(claim, review):
    """A positive verdict needs the reviewer's own addressed measurement in the same units.

    The reader adapter supplies typed values in source order (e.g. height, width).
    Matching a prose rationale against the claimant's text is insufficient.
    """
    verdict = review.get("verdict")
    if verdict != "confirmed":
        return verdict if verdict in {"unresolved", "rejected", "disputed"} else "unresolved"
    address_fields = ("source_revision", "mark", "location", "field", "unit")
    if any(not claim.get(key) or review.get(key) != claim[key] for key in address_fields):
        return "unresolved"
    if not review.get("receipt") or not claim.get("receipt") or review["receipt"] == claim["receipt"]:
        return "unresolved"
    if claim.get("value") is None or review.get("observed_value") is None:
        return "unresolved"
    if type(claim["value"]) is not type(review["observed_value"]):
        return "unresolved"
    return "confirmed" if claim["value"] == review["observed_value"] else "disputed"

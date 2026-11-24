"""Preserve source-line identity for schedule rows and compare explicitly grouped variants."""

import re
from collections import defaultdict


def windows(line_count, width=20, overlap=6):
    if line_count < 0 or width < 1 or overlap < 0:
        raise ValueError("invalid schedule window")
    for start in range(0, line_count, width):
        end = min(line_count, start + width)
        yield {"start": start, "end": end, "first": max(0, start - overlap),
               "stop": min(line_count, end + overlap)}


def _literal(text):
    # Keep alphabet, mirror markers and punctuation; collapse only PDF spacing.
    return "".join(text.split()).casefold()


def validate_row(item, *, source, lines, window):
    """Check source anchors and literal tokens. Semantic cell alignment requires a separate review."""
    if not isinstance(item, dict):
        return None, "row is not an object"
    mark, anchor = item.get("mark"), item.get("anchor")
    if not isinstance(mark, str) or not mark.strip() or type(anchor) is not int:
        return None, "missing literal mark or line anchor"
    if not window["first"] <= anchor < window["stop"] or anchor not in lines:
        return None, "anchor outside delivered lines"
    token = r"(?<![\w.*])" + re.escape(_literal(mark)) + r"(?![\w.*])"
    if not re.search(token, re.sub(r"\s+", " ", lines[anchor]).casefold()):
        return None, "mark not in anchored line"
    refs = item.get("lines")
    if not isinstance(refs, list) or not refs or any(type(i) is not int or i not in lines for i in refs):
        return None, "evidence line not in this delivery"
    qty = item.get("qty")
    if type(qty) is not int or qty < 0:
        return None, "missing explicit nonnegative quantity"
    if not any(re.search(r"(?<![\w.,])" + str(qty) + r"(?![\w.,])", lines[i]) for i in refs):
        return None, "quantity token not found in cited lines"
    group = item.get("group")
    if not isinstance(group, str) or not group.strip():
        return None, "missing explicit family"
    row = {**item, "mark": mark.strip(), "group": group.strip(), "source": source,
           "lines": sorted(set([anchor, *refs]))}
    return row, None


def compare_rows(left, right):
    """Count each physical mark occurrence once; multiple competing readings remain unresolved."""
    def side(rows):
        by_position = defaultdict(list)
        for row in rows:
            by_position[(row["source"], row["anchor"], row["mark"])].append(row)
        variants, conflicts = defaultdict(int), []
        for position, versions in sorted(by_position.items()):
            quantities = {row["qty"] for row in versions}
            if len(quantities) != 1:
                conflicts.append(position)
            else:
                variants[position[2]] += quantities.pop()
        return dict(variants), conflicts

    a, a_conflicts = side(left)
    b, b_conflicts = side(right)
    comparable = bool(a and b) and not (a_conflicts or b_conflicts)
    return {"left_variants": a, "right_variants": b, "left_subtotal": sum(a.values()),
            "right_subtotal": sum(b.values()), "conflicts": a_conflicts + b_conflicts,
            "equal_subtotals": sum(a.values()) == sum(b.values()) if comparable else None,
            "same_variant_counts": a == b if comparable else None}


def unaccounted_marks(lines, rows, tolerance=5):
    """Find short labels near the columns of observed schedule marks, including repeats.

    This is a navigational signal from one sheet's geometry. Titles, figure labels
    and neighbouring schedules may also match. A model must decide from the source.
    """
    labels = re.compile(r"(?<![\w.*-])[^\W\d_]{1,8}[-.]?\d{1,4}(?:[.-]\d{1,3})*[^\W\d_]?\*?(?![\w.*-])")
    known = {(r["anchor"], _literal(r["mark"])) for r in rows}
    columns = {m.start() for i, line in enumerate(lines) for m in labels.finditer(line)
               if (i, _literal(m[0])) in known}
    signals = []
    for i, line in enumerate(lines):
        for match in labels.finditer(line):
            if (i, _literal(match[0])) in known:
                continue
            if any(abs(match.start() - col) <= tolerance for col in columns):
                signals.append({"anchor": i, "column": match.start(), "label": match[0]})
    return signals


def decode_rows(text):
    """Accept one complete data envelope and preserve unstructured prose in the original trace."""
    import json
    candidates = [text.lstrip(), *re.findall(r"```(?:json)?\s*([\s\S]*?)```", text)]
    for candidate in candidates:
        try:
            value, _ = json.JSONDecoder().raw_decode(candidate.lstrip())
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("rows"), list):
            return value
    return None

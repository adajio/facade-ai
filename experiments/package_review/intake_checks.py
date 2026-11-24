"""Reader-neutral material for screening and inspecting automatically assigned source pairs."""

import re
from .source_relations import TOKEN, family_key


def compact_line(line):
    # Retain the physical columns without serializing long runs of padding.
    return " ".join(f"[{part.start()}]{part.group()}" for part in re.finditer(r"\S+(?: \S+)*", line))


def family_locations(lines, family):
    return [i for i, line in enumerate(lines)
            if any(family_key(m[0]) == family for m in TOKEN.finditer(line))]


def source_excerpt(ref, lines, *, family=None, limit=12500):
    selected = set(range(len(lines)))
    if family:
        hits = family_locations(lines, family)
        selected = {j for i in hits for j in range(max(0, i-4), min(len(lines), i+5))}
    ordered = sorted(selected)
    # For a large overview expose distributed samples and the exact gaps to the reader.
    if not family and sum(len(" ".join(lines[i].split())) for i in ordered) > limit:
        middle = ordered[::max(1, len(ordered)//24)]
        ordered = sorted(set(ordered[:7] + middle + ordered[-7:]))
    out, chars = [], 0
    for i in ordered:
        line = compact_line(lines[i])
        if chars + len(line) > limit and out:
            break
        out.append([i, line])
        chars += len(line)
    return {"ref": ref, "line_count": len(lines), "lines": out,
            "selected_lines": len(selected), "selection_complete": len(out) == len(selected),
            "whole_unit": len(out) == len(lines)}


def screening_cards(groups, units, number=3):
    cards = []
    for i, group in enumerate(groups):
        alternatives = []
        for edge in group[:number]:
            pair = {}
            hints = set(edge["labels"] + edge["phrases"])
            for ref in (edge["left"], edge["right"]):
                lines = units[ref]
                hits = [i for i,s in enumerate(lines) if any(h in s.casefold() for h in hints)]
                sample = dict.fromkeys([0, *hits[:2], *(hits[len(hits)//2:][:1])])
                pair[ref] = [[j, " ".join(lines[j].split())[:280]] for j in sample if j<len(lines)]
            alternatives.append({"left":edge["left"],"right":edge["right"],"common":edge["labels"][:9],
                                 "phrases":edge["phrases"][:4],"source_samples":pair})
        cards.append({"group":i, "alternatives":alternatives,"qualifying_edges":len(group)})
    return cards


def paired_outcome(records, units):
    """Navigation or a generic verdict cannot close a cross-source task."""
    if len(records) < 2:
        return "partial", False
    decisions = []
    for record in records:
        decision = record.get("decision")
        readings = record.get("sources", [])
        if not isinstance(readings, list) or not all(isinstance(r, dict) for r in readings):
            return "partial", False
        supported = {r.get("ref") for r in readings if isinstance(r.get("ref"), str)
                     and isinstance(r.get("reading"), str) and r["reading"].strip()
                     and isinstance(r.get("lines"), list) and r["lines"]}
        if decision not in {"compared", "different_scope"} or not set(units) <= supported:
            return "partial", False
        decisions.append(decision)
    if len(set(decisions)) > 1:
        return "disagreement", False
    return decisions[0], True

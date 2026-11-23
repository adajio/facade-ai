"""Build an engineer handoff from current source evidence; preserve reasons for held questions."""

import re

from .research import save


def agreed_quantities(readers):
    """Return only independently identical, attributed row counts; check explicit totals."""
    reports = []
    for answer in readers.values():
        side = {}
        for item in answer.get("sources", []):
            rows = item.get("amounts")
            if not rows:
                continue
            if not isinstance(rows, list):
                return {}, "ambiguous_quantity_rows"
            counts = {}
            for row in rows:
                if (
                    not isinstance(row, list)
                    or len(row) != 2
                    or not isinstance(row[0], str)
                    or type(row[1]) is not int
                    or row[1] < 0
                    or row[0] in counts
                ):
                    return {}, "ambiguous_quantity_rows"
                counts[row[0]] = row[1]
            total = item.get("total")
            if total is not None and (
                type(total) is not int or total != sum(counts.values())
            ):
                return {}, "subtotal_or_scope_requires_review"
            ref = item.get("ref")
            if ref in side:
                return {}, "duplicate_source_reading"
            side[ref] = counts
        reports.append(side)
    if len(reports) != 2 or reports[0] != reports[1]:
        return {}, "independent_quantity_readings_differ"
    return {
        ref: {"rows": counts, "sum_of_cited_rows": sum(counts.values())}
        for ref, counts in reports[0].items()
    }, None


def question_evidence(case, reviews, original_line, owner):
    """Require source-specific peer reasons, and locate reported counts at their own addresses."""
    result = case["result"]
    required = {case["a"], case["b"]}
    if (
        not isinstance(reviews, dict)
        or set(reviews) != set(result.get("answers", {}))
        or len(reviews) != 2
    ):
        return "missing_addressed_peer_review"
    for peer in reviews.values():
        if peer.get("verdict") != "supported" or not peer.get("reason"):
            return "peer_did_not_confirm"
        supported = set()
        if not isinstance(peer.get("proofs"), list):
            return "missing_reason_at_either_original"
        for proof in peer["proofs"]:
            if (
                not isinstance(proof, dict)
                or not str(proof.get("reason") or "").strip()
            ):
                continue
            ref, ids = proof.get("ref"), proof.get("lines")
            if not isinstance(ref, str) or not isinstance(ids, list) or not ids:
                continue
            if all(type(i) is int and original_line(ref, i) is not None for i in ids):
                supported.add(owner(ref))
        if not required <= supported:
            return "missing_reason_at_either_original"
    cited_text = []
    for answer in result["answers"].values():
        for source in answer.get("sources", []):
            lines = [original_line(source["ref"], i) for i in source["lines"]]
            if any(line is None for line in lines):
                return "missing_original_lines"
            text = " ".join(lines)
            cited_text.append(text)
            amounts = source.get("amounts") or []
            if not isinstance(amounts, list):
                return "ambiguous_quantity_rows"
            for row in amounts:
                if (
                    not isinstance(row, list)
                    or len(row) != 2
                    or type(row[1]) is not int
                ):
                    return "ambiguous_quantity_rows"
                label, count = row
                # Literal presence is a minimum. Attribution to the governing column
                # and extent remains the independent reviewers' responsibility.
                if str(label).casefold() not in text.casefold() or not re.search(
                    r"(?<![\w.,])" + re.escape(str(count)) + r"(?![\w.,])", text
                ):
                    return "unlocated_quantity_or_label"
    # Every literal number in a proposed question must occur in the provided evidence
    # or be a sum of addressed rows on which the independent readers agree.
    numbers = re.compile(r"(?<!\w)\d+(?:[.,]\d+)?(?!\w)")
    observed = {
        n.replace(",", ".") for text in cited_text for n in numbers.findall(text)
    }
    counts, caution = agreed_quantities(result["answers"])
    if not caution:
        observed.update(str(group["sum_of_cited_rows"]) for group in counts.values())
    draft = (result.get("proposal") or {}).get("text", "")
    if any(n.replace(",", ".") not in observed for n in numbers.findall(draft)):
        return "unlocated_number_in_customer_question"
    return None


def engineer_handoff(revision, cases, readings, coverage, *, evidence_check=None):
    by_id = {r["id"]: r for r in readings}
    items, drafts = [], []
    for case in cases:
        result = case.get("result") or {}
        answers = result.get("answers", {})
        amounts, caution = agreed_quantities(answers)
        basis = [by_id[k] for k in case["origin"] if k in by_id]
        traceable = (
            len(basis) == 2
            and len({f["source"] for f in basis}) == 2
            and len({f["job"] for f in basis}) == 2
            and case["rev"] == revision
        )
        proposal = result.get("proposal")
        held = []
        if proposal:
            if not traceable:
                held.append("unresolved_provenance")
            if (
                case["state"] != "peer_supported_conflict"
                or not proposal.get("review")
                or not proposal.get("stage")
                or not proposal.get("text")
                or len(set(proposal.get("basis", {}).values())) != 2
            ):
                held.append("incomplete_independent_review")
            if caution:
                held.append(caution)
            if not held:
                check = (
                    evidence_check(case)
                    if evidence_check
                    else "requires_original_check"
                )
                if check:
                    held.append(check)
            if not held:
                drafts.append(
                    {"case": case["id"], "version": case["version"], **proposal}
                )
        items.append(
            {
                "case": case["id"],
                "version": case["version"],
                "topic": case["topic"],
                "state": case["state"],
                **(
                    {"waiting_for": case["waiting_for"]}
                    if case.get("waiting_for")
                    else {}
                ),
                "trigger": basis,
                "basis": case["basis"],
                "answers": answers,
                "quantities": amounts,
                "quantity_caution": caution,
                "held_question": held,
                "receipts": result.get("receipts", {}),
            }
        )
    return {
        "revision": revision,
        "coverage": coverage,
        "readings": readings,
        "comparisons": items,
        "drafts": drafts,
        "approved": [],
        "decision": "awaiting_engineer",
    }


def write_handoff(
    directory, revision, cases, readings, coverage, *, evidence_check=None
):
    report = engineer_handoff(
        revision, cases, readings, coverage, evidence_check=evidence_check
    )
    save(directory / "engineer-handoff.json", report)
    return report

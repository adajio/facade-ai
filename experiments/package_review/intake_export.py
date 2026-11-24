"""Build an engineer-facing intake snapshot without allowing coverage to imply a missing supply."""

from .research import save


def export_intake(directory, tasks, observations, suggestions, *, revision, discovery_issues=()):
    """Keep validated evidence separate from outstanding model work and human authorization."""
    by_id = {}
    for fact in observations:
        key = fact["id"]
        if key in by_id and by_id[key] != fact:
            raise ValueError("two incompatible immutable observations")
        by_id[key] = fact
    proposals = []
    for suggestion in suggestions:
        basis = suggestion.get("basis", [])
        if (suggestion.get("kind") in {"confirmed_conflict", "confirmed_shortage"}
            and basis and all(by_id.get(i, {}).get("state") == "verified" for i in basis)
            and any(by_id[i].get("finding") == suggestion["kind"] for i in basis)):
            proposals.append(suggestion)
    result = {"package_revision":revision, "tasks":tasks, "discovery_issues":list(discovery_issues),
              "observations":list(by_id.values()), "draft_proposals":proposals,
              "approved_items":[], "decision":"awaiting_engineer"}
    save(directory / "intake.json", result)
    return result


def group_readings(rows, revision):
    """Show readings of a shared literal side by side; preserve scope and independent voices."""
    groups, unassigned, foreign_count = {}, [], 0
    for row in rows:
        term = row.get("term")
        if row.get("revision") != revision:
            foreign_count += 1
            continue
        if (not isinstance(term, str) or not term.strip()
                or not row.get("unit") or not row.get("receipt") or not row.get("lines")):
            unassigned.append(row)
            continue
        group = groups.setdefault(term, {"literal": term, "by_unit": {},
                                        "applicability": "requires_review"})
        group["by_unit"].setdefault(row["unit"], []).append(row)
    return {"groups": list(groups.values()), "unassigned": unassigned, "foreign_count": foreign_count}


def export_reading_inventory(directory, revision, rows, *, open_work=()):
    result = {"revision": revision, **group_readings(rows, revision), "open_work": list(open_work)}
    save(directory / "reading-inventory.json", result)
    return result


def apply_source_challenges(snapshot, challenges):
    """Create a new engineer view after an addressed challenge; preserve the paid snapshot."""
    import copy
    from .research import digest

    revised = copy.deepcopy(snapshot)
    facts = {x["id"]: x for x in revised["observations"]}
    for issue in challenges:
        fact = facts.get(issue.get("observation_id"))
        if (fact is None or issue.get("revision") != revised["package_revision"]
                or issue.get("statement_digest") != digest(fact["text"])
                or not issue.get("reason") or not issue.get("source_receipts")):
            raise ValueError("challenge must identify the exact statement, revision and evidence")
        fact["state"] = "open"
        fact["source_challenge"] = issue
    revised["draft_proposals"] = [p for p in revised["draft_proposals"]
                                  if all(facts[k]["state"] == "verified" for k in p["basis"])]
    if challenges and revised["approved_items"]:
        revised["decision"] = "requires_engineer_revalidation"
        revised["prior_approved_items"] = revised["approved_items"]
        revised["approved_items"] = []
    return revised

"""Checkpoint fine-grained inspections of related original units within a leased parent task."""

from pathlib import Path
import json

from .research import digest, save
from .source_relations import asymmetric_families


def comparison_work(directory, units, lines, decisions, inspect=None):
    """Persist every child before dispatch. A single parent lease owns this checkpoint.

    decisions holds evidence-validated whole-source readings, including recovered prefixes.
    A dispatch adapter may defer work, e.g. waiting for an unknown billed call to settle.
    Independent reviewers determine source applicability and the status of each child.
    """
    path = Path(directory) / "children.json"
    if len(units) != 2 or units[0] == units[1]:
        raise ValueError("two source units required")
    left, right = units
    revision = digest([(u, lines[u]) for u in units])
    state = json.loads(path.read_bytes()) if path.exists() else {
        "revision": revision, "units": list(units), "children": {}}
    if state["revision"] != revision or state["units"] != list(units):
        raise ValueError("inspection material changed")
    children = state["children"]
    if any(decisions):
        for case in asymmetric_families(lines[left], lines[right]):
            children.setdefault(case["family"], {"source_anchors": case, "state": "open"})
    save(path, state)
    if inspect:
        for key, item in children.items():
            if item["state"] == "complete":
                continue
            response = inspect(key, item)
            if response is None:
                break
            if response.get("complete") and not response.get("receipt"):
                raise ValueError("a completed inspection needs a verified result receipt")
            item.update({"state": "complete" if response.get("complete") else "open",
                         "latest": response})
            save(path, state)
    return state


def variant_agenda(tasks, units, owners):
    """Issue field-level work from both originals even when the whole-pair answer was lost.

    Interleave original pairs to avoid one densely annotated drawing absorbing the intake.
    Require an exact shared member to prioritise a divergent set. Side-only members and
    unmatched semantic descriptions still belong to the broader review.
    """
    from collections import defaultdict
    by_pair = defaultdict(list)
    for task in tasks:
        a, b = task["units"]
        for case in asymmetric_families(units[a], units[b]):
            common = set(case["left"]) & set(case["right"])
            if not common:
                continue
            count = len(set(case["left"]) | set(case["right"]))
            score = (count, len(common))
            group = tuple(sorted((owners[a], owners[b])))
            by_pair[group].append((score, task["task_id"], case["family"], [a, b]))
    ordered = []
    for group in by_pair.values():
        group.sort(key=lambda c: (-c[0][0], -c[0][1], c[1], c[2]))
    while any(by_pair.values()):
        for group in sorted(by_pair):
            if by_pair[group]:
                _, task, focus, pair = by_pair[group].pop(0)
                ordered.append({"task_id": task, "units": pair, "family": focus})
    return ordered


def drain_variants(folder, revision, tasks, units, owners, inspect=None):
    """Register the whole agenda first, then consume eligible work with fenced acknowledgements.

    inspect(case, units) returns (outcome, addressed_receipts, complete), or None to defer
    the rest of this execution window. The gateway owns reconciliation of dispatched calls.
    """
    from .reconciliation_queue import ReconciliationQueue
    folder = Path(folder)
    parents = {t["task_id"]: t for t in tasks}
    agenda = variant_agenda(tasks, units, owners)
    plan = folder / "variant-agenda.json"
    with ReconciliationQueue(folder / "variant-work.sqlite") as queue:
        for case in agenda:
            parent = parents[case["task_id"]]
            a, b = case["units"]
            child = queue.discover(scope=parent["scope"], package_revision=revision,
                                   left=a, right=b, kind="variants/" + case["family"],
                                   readers=parent["readers"],
                                   reasons=[{"kind": "variant_set", "origin": "intake",
                                             "reference": parent["task_id"]}])
            case["work_id"] = child["task_id"]
        save(plan, {"revision": revision, "agenda": agenda})
        if inspect:
            for case in agenda:
                key = case["work_id"]
                lease = queue.assign(key, worker="inspect_variants", lease_seconds=3600)
                if lease is None:
                    continue
                attempt = lease["attempt_id"]
                try:
                    answer = inspect(case, units)
                    if answer is None:
                        queue.fail(key, attempt, reason="deferred")
                        break
                    outcome, receipts, complete = answer
                    if complete:
                        queue.complete(key, attempt, outcome=outcome, evidence=receipts)
                    else:
                        queue.fail(key, attempt, reason=outcome, evidence=receipts)
                except Exception as exc:
                    current = queue.get(key)
                    if current["status"] == "assigned" and current["attempts"][-1]["attempt_id"] == attempt:
                        queue.fail(key, attempt, reason=str(exc).strip() or type(exc).__name__)
        result = [queue.get(c["work_id"]) for c in agenda]
        save(plan.with_name("variant-results.json"), result)
        return result

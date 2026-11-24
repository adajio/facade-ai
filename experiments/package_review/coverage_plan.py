"""Order paid source work by physical coverage and describe what is still outstanding."""

from collections import Counter, defaultdict, deque


def round_robin(groups):
    queues = deque(deque(group) for group in groups if group)
    while queues:
        group = queues.popleft()
        yield group.popleft()
        if group:
            queues.append(group)


def unit_id(job):
    return job.get("source", ""), job.get("unit", job["job"])


def was_opened(row):
    return bool(
        row.get("opened") or row.get("receipt") and row["state"] in {"read", "partial"}
    )


def reading_phases(plan, status):
    """One first reader per unseen unit, then each remaining window, then second readings/repairs."""
    originals = defaultdict(dict)
    for key, job in plan:
        owner, ref = unit_id(job)
        windows = originals[owner].setdefault(ref, {})
        windows.setdefault(job["job"], []).append((key, job))

    units = list(round_robin([list(refs.values()) for refs in originals.values()]))
    openings, extensions, remaining, repairs = [], [], [], []
    for ordinal, windows in enumerate(units):
        has_opening = any(
            was_opened(status.get(k, {})) for w in windows.values() for k, _ in w
        )
        first, extra, retry = [], [], []
        for choices in windows.values():
            # Stable alternating first reader spreads discovery across independent routes.
            offset = ordinal % len(choices)
            viable = [
                item
                for item in choices[offset:] + choices[:offset]
                if status.get(item[0], {}).get("state") not in {"read", "unavailable"}
            ]
            fresh = [item for item in viable if item[0] not in status]
            retry.extend(item for item in viable if item[0] in status)
            opened = any(was_opened(status.get(k, {})) for k, _ in choices)
            if fresh and not opened:
                first.append(fresh.pop(0))
            extra.extend(fresh)
        if not has_opening:
            if first:
                openings.append(first.pop(0))
            elif retry:
                openings.append(retry.pop(0))
        extensions.append(first)
        remaining.append(extra)
        repairs.append(retry)
    return (
        openings,
        round_robin(extensions),
        round_robin(remaining),
        round_robin(repairs),
    )


def coverage_summary(plan, status, originals=()):
    states = Counter()
    units = defaultdict(list)
    models = defaultdict(lambda: defaultdict(list))
    for key, job in plan:
        row = status.get(key, {"state": "pending"})
        states[row["state"]] += 1
        units[unit_id(job)].append(row)
        models[job.get("model", "default")][unit_id(job)].append(row)

    def counts(group):
        return {
            "units": len(group),
            "opened": sum(any(was_opened(r) for r in rows) for rows in group),
            "fully_read": sum(
                all(r["state"] == "read" for r in rows) for rows in group
            ),
            "with_unavailable_windows": sum(
                any(r["state"] == "unavailable" for r in rows) for rows in group
            ),
        }

    documents = defaultdict(list)
    for (owner, _), rows in units.items():
        documents[owner].append(rows)
    missing = sorted(set(originals) - documents.keys())
    for owner in missing:
        documents[owner] = []
    return {
        "originals_without_units": missing,
        **counts(units.values()),
        "model_windows": dict(states),
        "by_model": {model: counts(group.values()) for model, group in models.items()},
        "by_original": {owner: counts(group) for owner, group in documents.items()},
        "comparison_eligible": bool(plan)
        and not missing
        and all(state in {"read", "unavailable"} for state in states),
    }


def split_window(job):
    """Two strictly smaller source ranges; no extrapolation from an extracted observation."""
    from .research import digest

    lines = job.get("lines", [])
    if len(lines) <= 1:
        return []
    half = len(lines) // 2
    return [
        {
            **job,
            "parent_job": job["job"],
            "lines": part,
            "job": digest(["partial-window", job["job"], part]),
        }
        for part in (lines[:half], lines[half:])
    ]


def combined_window(parent, children):
    """A parent can close only if every physical subrange has a terminal result."""
    row = dict(parent)
    if all(c.get("state") == "read" for c in children):
        row.update(state="read", reason="completed_subranges")
    elif all(c.get("state") in {"read", "unavailable"} for c in children):
        row.update(
            state="unavailable", reason="documented_unavailable_subrange", opened=True
        )
    return row

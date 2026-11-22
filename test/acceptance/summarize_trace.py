"""Summarize frozen product traces. Each input uses one monotonic clock origin."""

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import median

from score import load


PHASES = (
    "received", "inventory", "firstEvidence", "unitCoverage",
    "branchesClosed", "reviewsClosed", "outcome",
)
GROUP = ("workloadClass", "mode", "routeRevision", "projectCount")
NS_PER_HOUR = 3_600_000_000_000


def summarize_attempts(attempts):
    keys = [item["id"] for item in attempts]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate attempt in the product trace")
    return {
        "attempts": len(attempts),
        "unconfirmedCost": sum(item["state"] == "unknown" for item in attempts),
        "spentNanos": sum(item["spentNanos"] for item in attempts),
        "reservedNanos": sum(item["reservedNanos"] for item in attempts),
        "promptTokens": sum(item["promptTokens"] or 0 for item in attempts),
        "completionTokens": sum(item["completionTokens"] or 0 for item in attempts),
        "missingTokenCounts": sum(
            item["promptTokens"] is None or item["completionTokens"] is None for item in attempts
        ),
        "http429": sum(item.get("httpStatus") == 429 for item in attempts),
        "timeouts": sum(item.get("timedOut") is True for item in attempts),
    }


def package_result(package, end):
    phases = package["phasesNs"]
    if any(phase not in PHASES for phase in phases):
        raise ValueError("Unrecognized phase in the product trace")
    start = package["startedNs"]
    if not 0 <= start <= end or any(not start <= value <= end for value in phases.values()):
        raise ValueError("Phase outside its observation window")
    if "received" in phases and any(value < phases["received"] for value in phases.values()):
        raise ValueError("Phase precedes sustained receipt")
    state = package["state"]
    result = {"state": state, "phasesNs": phases}
    if state == "complete":
        if set(phases) != set(PHASES) or any(value > phases["outcome"] for value in phases.values()):
            raise ValueError("Incomplete or inconsistent completed package timeline")
        return {**result, "durationNs": phases["outcome"] - phases["received"]}
    if state not in {"pending", "held", "failed"} or not package.get("reason"):
        raise ValueError("Unfinished package requires an observed state and reason")
    return {**result, "ageNs": end - start, "reason": package["reason"]}


def summarize(run):
    start, end = run["startedNs"], run["observedUntilNs"]
    if not 0 <= start < end:
        raise ValueError("Invalid observation window")
    package_ids = run["plannedPackageIds"]
    index = {item["id"]: item for item in run["packages"]}
    if (not package_ids or len(package_ids) != len(set(package_ids))
            or len(index) != len(run["packages"]) or set(index) != set(package_ids)):
        raise ValueError("Observed package IDs differ from the frozen denominator")
    groups = defaultdict(dict)
    attempts_by_group = defaultdict(list)
    for ident in package_ids:
        package = index[ident]
        if package["startedNs"] < start:
            raise ValueError("Package starts before its run")
        group = tuple(package[field] for field in GROUP)
        groups[group][ident] = package_result(package, end)
        attempts_by_group[group].extend(package["attempts"])
    # Check across groups as well, so one shared attempt is never counted twice.
    summarize_attempts([item for attempts in attempts_by_group.values() for item in attempts])
    results = []
    for group, contents in groups.items():
        times = sorted(item["durationNs"] for item in contents.values() if item["state"] == "complete")
        results.append({
            **dict(zip(GROUP, group)),
            "total": len(contents), "completed": len(times), "unfinished": len(contents) - len(times),
            "completedDurationNs": {
                "p50": median(times), "p95": times[math.ceil(0.95 * len(times)) - 1], "max": times[-1],
            } if times else None,
            "completedPerHour": len(times) * NS_PER_HOUR / (end - start),
            "packages": contents,
            "ledger": summarize_attempts(attempts_by_group[group]),
        })
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(load(args.trace)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

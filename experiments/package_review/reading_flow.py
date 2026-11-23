"""Register comparisons as readings arrive and protect primary coverage on a shared budget."""

import fcntl
import json
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from pathlib import Path

from .coverage_plan import (
    combined_window,
    coverage_summary,
    reading_phases,
    split_window,
)
from .cross_read import ReadingLedger
from .research import digest, save


@contextmanager
def revision_runner(directory, revision):
    """A concurrent reload shares this revision's gateway work and rechecks the ledger on entry."""
    with (directory / (digest(revision) + ".runner.lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def drain(pool, workers, can_send, take, execute, accept):
    active = {}
    while True:
        while len(active) < workers and can_send():
            item = take()
            if item is None:
                break
            active[pool.submit(execute, item)] = item
        if not active:
            return
        done, _ = wait(active, return_when=FIRST_COMPLETED)
        for future in done:
            accept(active.pop(future), future)


def reading_flow(
    directory,
    revision,
    jobs,
    read_job,
    compare,
    can_send,
    publish,
    *,
    workers=6,
    restore_source=None,
    source_only=False,
):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if workers < 1:
        raise ValueError("at least one worker required")
    with revision_runner(directory, revision):
        ledger = ReadingLedger(directory, revision, source_only=source_only)
        try:
            cases, issues = process(
                ledger,
                directory,
                jobs,
                read_job,
                compare,
                can_send,
                workers,
                restore_source,
            )
            return publish(revision, cases, issues)
        finally:
            ledger.db.close()


def process(
    ledger, directory, jobs, read_job, compare, can_send, workers, restore_source
):
    issues = []
    owner_file = directory / "unit-owners.json"
    owners = json.loads(owner_file.read_bytes()) if owner_file.exists() else {}

    def bind_jobs(rows):
        # Earlier reader profiles supplied the unit and delegated ownership to the inventory.
        for raw in rows:
            job = dict(raw)
            owner = owners.get(job.get("unit", job["job"]))
            if owner:
                if job.get("source", owner) != owner:
                    raise ValueError(
                        "source job disagrees with the verified unit owner"
                    )
                job["source"] = owner
            yield digest([ledger.revision, job["job"], job.get("model")]), job

    plan = list(bind_jobs(jobs))
    if len({key for key, _ in plan}) != len(plan):
        raise ValueError("source plan contains duplicate model jobs")
    prior_plan = directory / "source-plan.json"
    if directory.name == ledger.revision and prior_plan.exists():
        ledger.register_plan(bind_jobs(json.loads(prior_plan.read_bytes())))
    obligations = ledger.register_plan(plan)
    current_keys = {key for key, _ in plan}
    missing_keys = [key for key, _ in obligations if key not in current_keys]
    save(prior_plan, [j for _, j in obligations])

    def needs_split(row):
        return (
            row.get("state") == "partial"
            and row.get("reason") == "split_truncated_window"
        )

    def accept_source(item, future, *, restoring=False):
        key, _ = item
        try:
            result = future.result()
            if restoring and result is None:
                return
            if isinstance(result, list):
                result = {"observations": result, "state": "read"}
            state, facts = result["state"], result["observations"]
            reason = result.get("reason", "")
            if state not in {"read", "partial", "deferred", "unavailable"}:
                raise ValueError("invalid source result")
            receipt = result.get("receipt") or next(
                (f.get("receipt") for f in facts if f.get("receipt")), None
            )
            if not isinstance(receipt, str) or not receipt.strip():
                receipt = None
            if result.get("finish_reason") == "length" and state in {"read", "partial"}:
                state = "partial"
                reason = (
                    "split_truncated_window"
                    if receipt and len(item[1].get("lines", [])) > 1
                    else "truncated"
                )
            if state == "unavailable" and (not reason.strip() or not receipt or facts):
                raise ValueError(
                    "permanent reader failure requires diagnostic reason, receipt and no observations"
                )
            if state == "read" and not receipt:
                state, reason = "deferred", "no_delivery_receipt"
            if result.get("rejected"):
                save(
                    directory / "source-diagnostics" / (key + ".json"),
                    result["rejected"],
                )
            ledger.accept_source(key, item[1], facts, state, reason, receipt)
        except Exception as exc:  # noqa: BLE001 - preserve independent work after adapter failures.
            reason = str(exc) or type(exc).__name__
            issues.append({"kind": "read", "work": key, "error": reason})
            ledger.record_source(
                key, "needs_receipt" if restoring else "deferred", reason
            )

    def accept_comparison(case, future):
        try:
            result = future.result()
        except Exception as exc:  # noqa: BLE001 - preserve independent work after adapter failures.
            reason = str(exc) or type(exc).__name__
            issues.append({"kind": "compare", "work": case["id"], "error": reason})
            result = {"state": "open", "error": reason}
        try:
            ledger.finish(case, result)
        except ValueError as stale:
            issues.append({"kind": "compare", "work": case["id"], "error": str(stale)})

    with ThreadPoolExecutor(workers) as pool:
        prior = ledger.source_status()
        if restore_source is not None:
            legacy = iter(
                item
                for item in plan
                if prior.get(item[0], {}).get("state") == "needs_receipt"
            )
            drain(
                pool,
                workers,
                lambda: True,
                lambda: next(legacy, None),
                lambda item: restore_source(item[1]),
                lambda item, future: accept_source(item, future, restoring=True),
            )
        level = plan
        branches = []
        subranges = []
        while level:
            status = ledger.source_status()
            for phase in reading_phases(level, status):
                pending = iter(
                    item
                    for item in phase
                    if not needs_split(status.get(item[0], {}))
                    and status.get(item[0], {}).get("state") != "needs_receipt"
                )
                drain(
                    pool,
                    workers,
                    can_send,
                    lambda batch=pending: next(batch, None),
                    lambda item: read_job(item[1]),
                    accept_source,
                )
            status = ledger.source_status()
            next_level = []
            for key, job in level:
                if needs_split(status.get(key, {})):
                    children = [
                        (
                            digest([ledger.revision, child["job"], child.get("model")]),
                            child,
                        )
                        for child in split_window(job)
                    ]
                    if children:
                        branches.append((key, [child_key for child_key, _ in children]))
                        next_level.extend(children)
            subranges.extend(next_level)
            level = next_level
        status = ledger.source_status()
        for parent, children in reversed(branches):
            status[parent] = combined_window(
                status[parent], [status.get(k, {}) for k in children]
            )
        save(
            directory / "source-subranges.json",
            [{**j, **status.get(k, {"state": "pending"})} for k, j in subranges],
        )
        manifest = directory / "upload-manifest.json"
        originals = (
            set(json.loads(manifest.read_bytes()).values())
            if manifest.exists()
            else set()
        )
        for key in missing_keys:
            status[key] = {
                **status.get(key, {}),
                "state": "inventory_gap",
                "reason": "previously_planned_window_missing",
            }
        coverage = coverage_summary(obligations, status, originals)
        coverage["missing_windows"] = missing_keys
        if missing_keys:
            issues.append(
                {
                    "kind": "inventory",
                    "error": "previously_planned_windows_missing",
                    "count": len(missing_keys),
                }
            )
        for original in coverage["originals_without_units"]:
            issues.append(
                {
                    "kind": "inventory",
                    "source": original,
                    "error": "no_physical_representation",
                }
            )
        save(
            directory / "source-work.json",
            [
                {**job, **status.get(key, {"state": "pending"})}
                for key, job in obligations
            ],
        )
        save(directory / "coverage.json", coverage)
        # Reaching the end of an iterator, or losing gateway admission, does not
        # mean a window was read. Wait for all in-flight receipts before leasing.
        if coverage["comparison_eligible"] and not ledger.source_only:
            drain(pool, workers, can_send, ledger.claim, compare, accept_comparison)
    snapshot = ledger.snapshot()
    if not coverage["comparison_eligible"]:
        for case in snapshot:
            if case["state"] == "pending":
                case["waiting_for"] = "primary_coverage"
    save(directory / "cases.json", snapshot)
    save(directory / "readings.json", ledger.readings())
    save(directory / "issues.json", issues)
    return snapshot, issues

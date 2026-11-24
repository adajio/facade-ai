"""Ordinary intake orchestration for the trial. Provider, reader and storage adapters are injected."""

import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from pathlib import Path

from .comparison_work import drain_variants
from .reconciliation_queue import ReconciliationQueue
from .research import digest, save
from .source_relations import revision_of, source_signals, unexamined_pairs


_STRUCTURAL_BASIS = "Наиболее сильный структурный сигнал пересечения двух исходников; требуется проверить смысл."


def verify_originals(files, expected):
    if set(files) != set(expected) or not files:
        raise ValueError("source manifest and uploaded original set differ")
    for key, path in files.items():
        with Path(path).open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected[key]:
            raise ValueError("mismatched source revision: " + key)
    return revision_of(expected)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _error(exc):
    return str(exc).strip()[:1200].encode("utf-8", "replace").decode() or type(exc).__name__


def _basis_key(basis, material_key=None):
    if material_key is not None:
        return _json(["material", material_key.strip()])
    normalized = " ".join(basis.split()) if isinstance(basis, str) else basis
    return _json(["basis", normalized])


def _create_intake_state(conn):
    conn.execute("PRAGMA synchronous=FULL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS intake_units (
            scope TEXT NOT NULL, revision TEXT NOT NULL, pins TEXT NOT NULL,
            PRIMARY KEY (scope, revision)
        );
        CREATE TABLE IF NOT EXISTS intake_signals (
            scope TEXT NOT NULL, revision TEXT NOT NULL, left_unit TEXT NOT NULL,
            right_unit TEXT NOT NULL, basis_key TEXT NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY (scope, revision, left_unit, right_unit, basis_key, payload)
        );
    """)


def _bind_aliases(conn, identity, units, owners):
    """Pin queue keys for a revision and rebind an unambiguous reader rename."""
    current = {unit: digest([owners[unit], lines]) for unit, lines in units.items()}
    with conn:
        conn.execute("INSERT INTO intake_units VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                     (*identity, _json(current)))
        pinned = json.loads(conn.execute("SELECT pins FROM intake_units WHERE scope = ? AND revision = ?",
                                         identity).fetchone()[0])
    active = {unit: unit for unit, signature in pinned.items() if current.get(unit) == signature}
    unmatched = set(current) - active.keys()
    old = set(pinned) - active.keys()
    if len(unmatched) != len(old):
        raise ValueError("reader unit inventory changed within the same package revision")
    for unit in sorted(old):
        matches = [alias for alias in unmatched if current[alias] == pinned[unit]]
        if len(matches) != 1:
            raise ValueError("reader units changed or aliases are ambiguous within the same package revision")
        active[unit] = matches[0]
        unmatched.remove(matches[0])
    return active


def _signal_rows(conn, identity):
    return conn.execute(
        "SELECT left_unit, right_unit, basis_key, payload FROM intake_signals "
        "WHERE scope = ? AND revision = ? ORDER BY rowid", identity,
    )


def _remember_signal(conn, identity, pair, key, reason):
    # Each basis has one queue reason. The ledger also retains independent channels repeating it.
    with conn:
        conn.execute("INSERT INTO intake_signals VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                     (*identity, *pair, key, _json(reason)))
        row = conn.execute(
            "SELECT payload FROM intake_signals WHERE scope = ? AND revision = ? AND left_unit = ? "
            "AND right_unit = ? AND basis_key = ? ORDER BY rowid LIMIT 1", (*identity, *pair, key),
        ).fetchone()
    return json.loads(row[0])


def _store_snapshot(folder, directory, name, data):
    save(directory / name, data)
    # Keep the trial's existing paths as views of the current invocation.
    save(folder / name, data)


def _inspect_with_aliases(case, inspect, units, aliases, stable):
    addressed_units = [aliases[key] for key in case["units"]]
    answer = inspect({**case, "units": addressed_units}, units)
    if answer is None:
        return None
    outcome, received, complete = answer
    if not isinstance(received, (list, tuple)):
        raise ValueError("inspection evidence must be a list or tuple")
    evidence = []
    for row in received:
        unit = row.get("unit") if isinstance(row, dict) else None
        if unit not in addressed_units:
            raise ValueError("receipt must reference a presented source unit")
        if stable[unit] != unit:
            row = {**row, "unit": stable[unit], "reader_unit_alias": unit}
        evidence.append(row)
    return outcome, evidence, complete


def _inspect(queue_path, task_id, inspect, units, aliases, stable):
    with ReconciliationQueue(queue_path) as worker:
        attempt = worker.assign(task_id, worker="compare_sources", lease_seconds=3600)
        if not attempt:
            return None
        attempt_id = attempt["attempt_id"]
        task = worker.get(task_id)
        evidence = ()
        try:
            answer = _inspect_with_aliases(task, inspect, units, aliases, stable)
            if answer is None:
                raise ValueError("inspection must provide an outcome")
            outcome, evidence, complete = answer
            if type(complete) is not bool:
                raise ValueError("inspection completion flag must be a boolean")
            if complete:
                worker.complete(task_id, attempt_id, outcome=outcome, evidence=evidence)
            else:
                worker.fail(task_id, attempt_id, reason=outcome, evidence=evidence)
        except Exception as exc:
            issue = {"source": "inspection", "task_id": task_id, "error": _error(exc)}
            current = worker.get(task_id)
            if current["status"] != "assigned" or current["attempts"][-1]["attempt_id"] != attempt_id:
                return issue
            try:
                try:
                    worker.fail(task_id, attempt_id, reason=issue["error"], evidence=evidence)
                except (ValueError, TypeError):
                    worker.fail(task_id, attempt_id, reason=issue["error"])
            except (ValueError, TypeError) as error:
                issue["record_error"] = _error(error)
            return issue
    return None


def ordinary_upload(*, files, expected, read, survey, screen, inspect, publish, folder,
                    readers, scope="package-intake", parallelism=4, semantic_screen=None,
                    inspect_variant=None, reading_profile=None, on_verified=None):
    """Verify a package, persist automatic obligations and publish one revision's work."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    revision = verify_originals(files, expected)
    if on_verified is not None:
        on_verified(revision)
    identity = (scope, revision)
    directory = folder / "revisions" / digest(scope) / revision
    inventory = read(files, expected)
    if len(inventory) == 3 and reading_profile is not None:
        units, owners, document_metadata = inventory
    else:
        units, owners = inventory
        document_metadata = {}
    if set(units) != set(owners) or not set(owners.values()) <= set(expected.values()):
        raise ValueError("all reader units must resolve to an uploaded revision")
    if reading_profile is not None:
        save(directory / "upload-manifest.json", expected)
        save(directory / "unit-owners.json", owners)
        save(directory / "document-metadata.json", document_metadata)
        return reading_profile(directory, revision, units, owners, publish)
    db = folder / "work.sqlite"
    issues = []
    with ReconciliationQueue(db) as queue, closing(sqlite3.connect(db)) as conn:
        _create_intake_state(conn)
        aliases = _bind_aliases(conn, identity, units, owners)
        stable = {alias: key for key, alias in aliases.items()}
        pinned_lines = {key: units[alias] for key, alias in aliases.items()}
        pinned_owners = {key: owners[alias] for key, alias in aliases.items()}
        groups = source_signals(pinned_lines, pinned_owners)
        current_groups = [[{**edge, "left": aliases[edge["left"]], "right": aliases[edge["right"]]}
                           for edge in group] for group in groups]
        unexamined = unexamined_pairs(units, owners, current_groups)
        unexamined_originals = {tuple(row["originals"]) for row in unexamined}
        _store_snapshot(folder, directory, "candidate-edges.json", groups)
        _store_snapshot(folder, directory, "unexamined-originals.json", unexamined)

        def discover(pair, reason):
            return queue.discover(scope=scope, package_revision=revision, left=pair[0], right=pair[1],
                                  reasons=[reason], readers=readers)

        def record(pair, key, origin, reference, basis):
            reason = {"kind": "compare_sources", "origin": origin, "reference": reference, "basis": basis}
            return discover(pair, _remember_signal(conn, identity, pair, key, reason))

        # Recover a committed proposal if the process stopped before it reached the work queue.
        remembered = set()
        for left, right, key, payload in _signal_rows(conn, identity):
            pair_key = (left, right, key)
            if pair_key not in remembered:
                discover((left, right), json.loads(payload))
                remembered.add(pair_key)

        admissible = {tuple(sorted((edge["left"], edge["right"]))) for group in groups for edge in group}
        mandatory = {}
        for index, group in enumerate(groups):
            pair = tuple(sorted((group[0]["left"], group[0]["right"])))
            reference = f"candidate-edges.json#{index}/0"
            mandatory[pair] = reference
            record(pair, _basis_key(_STRUCTURAL_BASIS), "physical-overlap", reference, _STRUCTURAL_BASIS)

        def proposal_task(item, origin, stage):
            if not isinstance(item, dict):
                raise ValueError("proposal must be an object")
            a, b = item.get("left"), item.get("right")
            if not isinstance(a, str) or not isinstance(b, str) or a not in stable or b not in stable:
                raise ValueError("proposal must identify two current source units")
            if owners[a] == owners[b]:
                raise ValueError("proposal units must belong to distinct uploaded originals")
            pair = tuple(sorted((stable[a], stable[b])))
            reference, basis = item.get("reference"), item.get("reason")
            if not isinstance(reference, str) or not reference.strip():
                raise ValueError("proposal must have a source reference")
            if stage == "structure":
                if pair not in admissible:
                    raise ValueError("screen proposal is outside the structural alternatives")
                if pair in mandatory and reference == mandatory[pair]:
                    return None  # Older screen adapters repeat the mandatory structural registration.
            if stage == "semantic" and tuple(sorted((owners[a], owners[b]))) not in unexamined_originals:
                raise ValueError("semantic screen proposal is outside the unexamined originals")
            if not isinstance(basis, (str, dict, list)) or not basis or isinstance(basis, str) and not basis.strip():
                raise ValueError("proposal must have a nonempty comparison basis")
            material_key = item.get("basis_key")
            if material_key is not None and (not isinstance(material_key, str) or not material_key.strip()):
                raise ValueError("proposal basis_key must be nonempty text")
            return record(pair, _basis_key(basis, material_key), origin, reference, basis)

        def snapshot():
            return queue.list_tasks(scope=scope, package_revision=revision)

        with ThreadPoolExecutor(max_workers=parallelism) as consumers:
            submitted, jobs = set(), {}

            def submit(task):
                if task is None or task["status"] != "open" or task["task_id"] in submitted:
                    return
                task_id = task["task_id"]
                submitted.add(task_id)
                if any(unit not in aliases for unit in task["units"]):
                    issues.append({"source": "inspection", "task_id": task_id,
                                   "error": "persisted source units are unavailable in the current reader inventory"})
                    return
                jobs[consumers.submit(_inspect, db, task_id, inspect, units, aliases, stable)] = task_id

            def collect_jobs():
                for job in as_completed(jobs):
                    try:
                        issue = job.result()
                    except Exception as exc:
                        issue = {"source": "inspection", "task_id": jobs[job], "error": _error(exc)}
                    if issue:
                        issues.append(issue)
                jobs.clear()

            for task in snapshot():
                submit(task)
            with ThreadPoolExecutor(max_workers=len(readers) + 2) as producers:
                sources = {producers.submit(survey, name, units): (name, "survey") for name in readers}
                if groups:
                    sources[producers.submit(screen, current_groups, units)] = ("physical-overlap", "structure")
                if unexamined and semantic_screen is not None:
                    sources[producers.submit(semantic_screen, unexamined, units)] = ("semantic-screen", "semantic")
                for future in as_completed(sources):
                    origin, stage = sources[future]
                    try:
                        proposals = future.result()
                        if not isinstance(proposals, (list, tuple)):
                            raise ValueError("source proposal envelope must be a list or tuple")
                    except Exception as exc:
                        issues.append({"source": origin, "error": _error(exc)})
                        continue
                    for item in proposals:
                        try:
                            submit(proposal_task(item, origin, stage))
                        except (TypeError, ValueError) as exc:
                            issues.append({"source": origin, "status": "invalid", "error": _error(exc)})
            collect_jobs()
            # Late provenance for the same basis leaves reason_count unchanged. New material may invalidate a lease.
            submitted.clear()
            for task in snapshot():
                if task["attempts"] and task["attempts"][-1]["reason_count"] < len(task["reasons"]):
                    submit(task)
            collect_jobs()

        by_pair = {}
        for left, right, _, payload in _signal_rows(conn, identity):
            by_pair.setdefault((left, right), []).append(json.loads(payload))
        tasks = [{**task, "proposal_sources": by_pair.get(tuple(task["units"]), [])} for task in snapshot()]

    def variant_adapter(case, _pinned_units):
        answer = _inspect_with_aliases(case, inspect_variant, units, aliases, stable)
        if answer is not None and type(answer[2]) is not bool:
            raise ValueError("inspection completion flag must be a boolean")
        return answer

    available = [task for task in tasks if all(unit in pinned_lines for unit in task["units"])]
    checks = {task["task_id"]: [] for task in tasks}
    try:
        children = drain_variants(directory, revision, available, pinned_lines, pinned_owners,
                                  variant_adapter if inspect_variant is not None else None)
        result_path = directory.relative_to(folder) / "variant-results.json"
        for child in children:
            for basis in child["reasons"]:
                parent_id = basis["reference"]
                if basis["kind"] == "variant_set" and parent_id in checks:
                    checks[parent_id].append({"work_id": child["task_id"], "kind": child["kind"],
                                              "status": child["status"], "basis": basis,
                                              "reference": f"{result_path.as_posix()}#{child['task_id']}"})
    except Exception as exc:
        issues.append({"source": "variant-inspection", "error": _error(exc)})
    tasks = [{**task, "variant_checks": checks[task["task_id"]]} for task in tasks]
    _store_snapshot(folder, directory, "discovery-issues.json", issues)
    return publish(revision, tasks, issues)

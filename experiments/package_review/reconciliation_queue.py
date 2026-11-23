"""Durable work discovered while comparing sources in a package revision."""

import hashlib
import json
import math
import sqlite3
import time
from contextlib import contextmanager


def _text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a nonempty string")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ValueError(f"{field} must be valid UTF-8 text") from None
    return value


def _json(value):
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))


class ReconciliationQueue:
    """One SQLite connection per thread, sharing the queue file across workers."""

    def __init__(self, path, *, clock=time.time):
        self._clock = clock
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS reconciliation_tasks (
                task_id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                package_revision TEXT NOT NULL,
                kind TEXT NOT NULL,
                units TEXT NOT NULL,
                readers TEXT NOT NULL,
                discovered_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS reconciliation_scope
                ON reconciliation_tasks (scope, package_revision, discovered_at, task_id);
            CREATE TABLE IF NOT EXISTS reconciliation_reasons (
                task_id TEXT NOT NULL REFERENCES reconciliation_tasks (task_id),
                payload TEXT NOT NULL,
                PRIMARY KEY (task_id, payload)
            );
            CREATE TABLE IF NOT EXISTS reconciliation_attempts (
                attempt_id INTEGER PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES reconciliation_tasks (task_id),
                worker TEXT NOT NULL,
                assigned_at REAL NOT NULL,
                lease_until REAL NOT NULL,
                reason_count INTEGER NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('assigned', 'failed', 'expired', 'closed')),
                ended_at REAL,
                result TEXT
            );
            CREATE INDEX IF NOT EXISTS reconciliation_attempt_history
                ON reconciliation_attempts (task_id, attempt_id);
            CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_active_assignment
                ON reconciliation_attempts (task_id) WHERE status = 'assigned';
        """)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def close(self):
        self._db.close()

    @contextmanager
    def _transaction(self, *, write=False):
        self._db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        try:
            yield
            self._db.commit()
        except BaseException:
            self._db.rollback()
            raise

    def discover(self, *, scope, package_revision, left, right, reasons, readers,
                 kind="compare_sources"):
        """Register source-pair work and merge reasons from every discovery origin."""
        for field, value in (("scope", scope), ("package_revision", package_revision), ("kind", kind),
                             ("left", left), ("right", right)):
            _text(value, field)
        if left == right:
            raise ValueError("comparison requires two distinct units")
        units = sorted([left, right])
        if not isinstance(readers, (list, tuple)):
            raise ValueError("readers must be a sequence of independent reader IDs")
        readers = sorted(_text(reader, "reader") for reader in readers)
        if len(readers) < 2 or len(readers) != len(set(readers)):
            raise ValueError("comparison requires at least two distinct readers")
        if not isinstance(reasons, (list, tuple)) or not reasons:
            raise ValueError("discovery requires at least one reason")
        for reason in reasons:
            if not isinstance(reason, dict):
                raise ValueError("each discovery reason must be an object")
            for field in ("kind", "origin", "reference"):
                _text(reason.get(field), f"reason {field}")
        task_id = hashlib.sha256(_json([scope, package_revision, kind, units]).encode()).hexdigest()
        with self._transaction(write=True):
            now = self._clock()
            self._db.execute(
                "INSERT INTO reconciliation_tasks VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(task_id) DO NOTHING",
                (task_id, scope, package_revision, kind, _json(units), _json(readers), now),
            )
            task = self._task(task_id)
            if task["readers"] != readers:
                raise ValueError("reader assignment differs for the existing source-pair task")
            self._db.executemany(
                "INSERT INTO reconciliation_reasons VALUES (?, ?) ON CONFLICT DO NOTHING",
                ((task_id, _json(reason)) for reason in reasons),
            )
            return self._snapshot(task, now)

    def _task(self, task_id):
        row = self._db.execute(
            "SELECT * FROM reconciliation_tasks WHERE task_id = ?", (task_id,),
        ).fetchone()
        if row is None:
            raise KeyError(task_id)
        return {**row, "units": json.loads(row["units"]), "readers": json.loads(row["readers"])}

    @staticmethod
    def _attempt(row):
        return {**row, "result": json.loads(row["result"]) if row["result"] else None}

    def _snapshot(self, task, now):
        task_id = task["task_id"]
        reasons = [json.loads(row["payload"]) for row in self._db.execute(
            "SELECT payload FROM reconciliation_reasons WHERE task_id = ? ORDER BY rowid", (task_id,),
        )]
        attempts = [self._attempt(row) for row in self._db.execute(
            "SELECT * FROM reconciliation_attempts WHERE task_id = ? ORDER BY attempt_id", (task_id,),
        )]
        status = "open"
        if attempts:
            latest = attempts[-1]
            if latest["status"] == "assigned" and latest["lease_until"] > now:
                status = "assigned"
            if latest["status"] == "closed" and latest["reason_count"] == len(reasons):
                status = "closed"
        return {**task, "status": status, "reasons": reasons, "attempts": attempts}

    def get(self, task_id):
        with self._transaction():
            return self._snapshot(self._task(task_id), self._clock())

    def list_tasks(self, *, scope, package_revision):
        with self._transaction():
            now = self._clock()
            return [self._snapshot(self._task(row["task_id"]), now) for row in self._db.execute(
                "SELECT task_id FROM reconciliation_tasks WHERE scope = ? AND package_revision = ? "
                "ORDER BY discovered_at, task_id", (scope, package_revision),
            )]

    def assign(self, task_id, *, worker, lease_seconds=300):
        """Lease an open task. The attempt ID fences acknowledgments from old workers."""
        _text(worker, "worker")
        try:
            if type(lease_seconds) not in (int, float) or not math.isfinite(lease_seconds) or lease_seconds <= 0:
                raise ValueError("lease_seconds must be positive and finite")
        except OverflowError:
            raise ValueError("lease_seconds must be positive and finite") from None
        with self._transaction(write=True):
            now = self._clock()
            task = self._snapshot(self._task(task_id), now)
            if task["status"] != "open":
                return None
            lease_until = now + lease_seconds
            if not math.isfinite(lease_until) or lease_until <= now:
                raise ValueError("lease expiry must be finite and after assignment")
            self._db.execute(
                "UPDATE reconciliation_attempts SET status = 'expired', ended_at = ? "
                "WHERE task_id = ? AND status = 'assigned' AND lease_until <= ?", (now, task_id, now),
            )
            cursor = self._db.execute(
                "INSERT INTO reconciliation_attempts "
                "(task_id, worker, assigned_at, lease_until, reason_count, status) "
                "VALUES (?, ?, ?, ?, ?, 'assigned')",
                (task_id, worker, now, lease_until, len(task["reasons"])),
            )
            return self._attempt(self._get_attempt(task_id, cursor.lastrowid))

    def _get_attempt(self, task_id, attempt_id):
        row = self._db.execute(
            "SELECT * FROM reconciliation_attempts WHERE task_id = ? AND attempt_id = ?",
            (task_id, attempt_id),
        ).fetchone()
        if row is None:
            raise KeyError(attempt_id)
        return row

    @staticmethod
    def _evidence(task, evidence, *, complete):
        if not isinstance(evidence, (list, tuple)):
            raise ValueError("evidence must be a sequence of source receipts")
        expected = {(reader, unit) for reader in task["readers"] for unit in task["units"]}
        pairs, receipts, canonical = set(), {}, set()
        for item in evidence:
            if not isinstance(item, dict):
                raise ValueError("each receipt must be an object")
            for field in ("reader", "unit", "receipt", "location"):
                _text(item.get(field), f"evidence {field}")
            pair = (item["reader"], item["unit"])
            if pair not in expected:
                raise ValueError("receipt must identify an assigned reader and source unit")
            if receipts.setdefault(item["receipt"], pair) != pair:
                raise ValueError("receipt cannot be shared across readers or source units")
            pairs.add(pair)
            canonical.add(_json(item))
        if complete and pairs != expected:
            raise ValueError("closing the task requires addressed evidence from every reader on both units")
        return [json.loads(item) for item in sorted(canonical)]

    def _finish(self, task_id, attempt_id, status, result, evidence):
        with self._transaction(write=True):
            now = self._clock()
            task = self._task(task_id)
            attempt = self._get_attempt(task_id, attempt_id)
            complete = status == "closed"
            payload = _json({**result, "evidence": self._evidence(task, evidence, complete=complete)})
            if attempt["status"] == status and attempt["result"] == payload:
                return self._snapshot(task, now)
            if attempt["status"] != "assigned" or attempt["lease_until"] <= now:
                raise ValueError("attempt is no longer assigned")
            if complete:
                count = self._db.execute(
                    "SELECT COUNT(*) FROM reconciliation_reasons WHERE task_id = ?", (task_id,),
                ).fetchone()[0]
                if count != attempt["reason_count"]:
                    raise ValueError("new reasons arrived during assignment; retry with all reasons")
            self._db.execute(
                "UPDATE reconciliation_attempts SET status = ?, ended_at = ?, result = ? "
                "WHERE attempt_id = ?", (status, now, payload, attempt_id),
            )
            return self._snapshot(task, now)

    def fail(self, task_id, attempt_id, *, reason, evidence=()):
        """Retain diagnostic and any acquired evidence, then expose the task for retry."""
        return self._finish(task_id, attempt_id, "failed", {"reason": _text(reason, "reason")}, evidence)

    def complete(self, task_id, attempt_id, *, outcome, evidence):
        """Close with the caller's comparison outcome and a receipt for each reader and unit."""
        return self._finish(task_id, attempt_id, "closed", {"outcome": _text(outcome, "outcome")}, evidence)

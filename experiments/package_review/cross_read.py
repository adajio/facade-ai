"""Transactional subscription to addressed readings from independent source jobs."""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from .research import digest


class ReadingLedger:
    def __init__(self, directory, revision, *, source_only=False):
        self.source_only = source_only
        self.revision = revision
        self.db = sqlite3.connect(Path(directory) / "reading-ledger.sqlite", timeout=45)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS readings(id TEXT PRIMARY KEY, rev TEXT, topic TEXT, src TEXT,
          job TEXT, data TEXT);
        CREATE INDEX IF NOT EXISTS related ON readings(rev,topic,src);
        CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, rev TEXT, topic TEXT, a TEXT, b TEXT,
          version INTEGER, updated REAL, origin TEXT, priority REAL);
        CREATE TABLE IF NOT EXISTS attempts(case_id TEXT, version INTEGER, token TEXT PRIMARY KEY,
          leased REAL, expires REAL, finished REAL, inputs TEXT, result TEXT);
        CREATE INDEX IF NOT EXISTS active ON attempts(case_id,version);
        CREATE TABLE IF NOT EXISTS receipt_migrations(rev TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS receipt_bindings(rev TEXT,receipt TEXT,binding TEXT,
            PRIMARY KEY(rev,receipt));
        CREATE TABLE IF NOT EXISTS source_work(rev TEXT,id TEXT,state TEXT,reason TEXT,
            PRIMARY KEY(rev,id));
        CREATE TABLE IF NOT EXISTS primary_obligations(rev TEXT,id TEXT,payload TEXT, PRIMARY KEY(rev,id));
        CREATE TABLE IF NOT EXISTS retries(prior_token TEXT PRIMARY KEY, reason TEXT);

        """)

        # Old 'read' rows did not distinguish an empty pre-send failure from an
        # accepted empty result. Reconcile them through the reader's receipt cache.
        with self.write():
            columns = {
                row["name"] for row in self.db.execute("PRAGMA table_info(source_work)")
            }
            if "receipt" not in columns:
                self.db.execute("ALTER TABLE source_work ADD COLUMN receipt TEXT")
                self.db.execute(
                    "UPDATE source_work SET state='needs_receipt' WHERE state IN ('read','partial')"
                )
            if "opening_receipt" not in columns:
                self.db.execute(
                    "ALTER TABLE source_work ADD COLUMN opening_receipt TEXT"
                )
                self.db.execute(
                    "UPDATE source_work SET opening_receipt=receipt WHERE state IN ('read','partial')"
                )
        with self.write():
            migrated = self.db.execute(
                "SELECT 1 FROM receipt_migrations WHERE rev=?", (revision,)
            ).fetchone()
            if not migrated:
                for row in self.db.execute(
                    "SELECT data FROM readings WHERE rev=? ORDER BY id", (revision,)
                ):
                    self.bind_receipt(json.loads(row[0]))
                self.db.execute("INSERT INTO receipt_migrations VALUES(?)", (revision,))

    def bind_receipt(self, fact):
        binding = digest([fact["source"], fact["unit"], fact["job"], fact["model"]])
        self.db.execute(
            "INSERT OR IGNORE INTO receipt_bindings VALUES (?,?,?)",
            (self.revision, fact["receipt"], binding),
        )
        original = self.db.execute(
            "SELECT binding FROM receipt_bindings WHERE rev=? AND receipt=?",
            (self.revision, fact["receipt"]),
        ).fetchone()[0]
        if original != binding:
            raise ValueError("one receipt cannot belong to another source job or model")

    @contextmanager
    def write(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def register_plan(self, plan):
        with self.write():
            self.db.executemany(
                """INSERT INTO primary_obligations VALUES (?,?,?)
                ON CONFLICT(rev,id) DO UPDATE SET payload=json_set(
                    primary_obligations.payload, '$.source', json_extract(excluded.payload,'$.source'))
                WHERE json_extract(primary_obligations.payload,'$.source') IS NULL
                  AND json_extract(excluded.payload,'$.source') IS NOT NULL
                  AND json_extract(primary_obligations.payload,'$.unit') IS json_extract(excluded.payload,'$.unit')
                """,
                (
                    (self.revision, key, json.dumps(job, ensure_ascii=False))
                    for key, job in plan
                ),
            )
            return [
                (r["id"], json.loads(r["payload"]))
                for r in self.db.execute(
                    "SELECT id,payload FROM primary_obligations WHERE rev=? ORDER BY rowid",
                    (self.revision,),
                )
            ]

    def completed_sources(self):
        return {
            key for key, row in self.source_status().items() if row["state"] == "read"
        }

    def record_source(self, key, state, reason, receipt=None):
        with self.write():
            self._record_source(key, state, reason, receipt)

    def _record_source(self, key, state, reason, receipt):
        opening = receipt if state in {"read", "partial"} else None
        self.db.execute(
            """
            INSERT INTO source_work (rev,id,state,reason,receipt,opening_receipt)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(rev,id) DO UPDATE SET state=excluded.state,
                reason=excluded.reason, receipt=excluded.receipt,
                opening_receipt=COALESCE(source_work.opening_receipt,excluded.opening_receipt)
            """,
            (self.revision, key, state, reason, receipt, opening),
        )

    def source_status(self):
        return {
            r["id"]: {
                "state": r["state"],
                "reason": r["reason"],
                "receipt": r["receipt"],
                "opened": bool(r["opening_receipt"]),
                "opening_receipt": r["opening_receipt"],
            }
            for r in self.db.execute(
                "SELECT * FROM source_work WHERE rev=?", (self.revision,)
            )
        }

    def readings(self):
        return [
            json.loads(r[0])
            for r in self.db.execute(
                "SELECT data FROM readings WHERE rev=? ORDER BY id", (self.revision,)
            )
        ]

    def accept_source(self, key, job, facts, state, reason, receipt):
        """Bind also empty results. Source outcome and triggered cases have one commit point."""
        fields = ("source", "unit", "job", "model")
        binding = {
            name: job.get(name, facts[0].get(name) if facts else None)
            for name in fields
        }
        if any(f.get(name) != value for f in facts for name, value in binding.items()):
            raise ValueError("observation belongs to another source job or model")
        with self.write():
            if receipt:
                self.bind_receipt({**binding, "receipt": receipt})
            self._ingest(facts)
            self._record_source(key, state, reason, receipt)

    def ingest(self, facts):
        """An immutable fact and any newly enabled comparisons commit together."""
        with self.write():
            self._ingest(facts)

    def _ingest(self, facts):
        touched = {}
        for f in facts:
            if (
                not all(
                    isinstance(f.get(k), str) and f[k].strip()
                    for k in (
                        "source",
                        "unit",
                        "topic",
                        "job",
                        "model",
                        "receipt",
                        "text",
                        "label",
                    )
                )
                or f.get("role") not in {"data", "mention"}
                or not isinstance(f.get("lines"), list)
                or not f["lines"]
                or not all(type(i) is int and i >= 0 for i in f["lines"])
            ):
                raise ValueError("an addressed source reading is required")
            if f.get("revision", self.revision) != self.revision:
                raise ValueError("reading belongs to another revision")
            self.bind_receipt(f)
            fid = digest(
                [
                    self.revision,
                    {key: value for key, value in f.items() if key != "revision"},
                ]
            )
            row = {**f, "id": fid}
            inserted = self.db.execute(
                "INSERT OR IGNORE INTO readings VALUES (?,?,?,?,?,?)",
                (
                    fid,
                    self.revision,
                    f["topic"],
                    f["source"],
                    f["job"],
                    json.dumps(row, ensure_ascii=False),
                ),
            )
            if not inserted.rowcount or self.source_only:
                continue
            for peer in self.db.execute(
                """SELECT src,id FROM readings WHERE rev=? AND topic=?
                    AND src<>? AND job<>? ORDER BY id""",
                (self.revision, f["topic"], f["source"], f["job"]),
            ):
                a, b = sorted((f["source"], peer["src"]))
                touched.setdefault((f["topic"], a, b), [peer["id"], fid])
        for (topic, a, b), origin in touched.items():
            key = digest([self.revision, topic, a, b])
            facts = self.material(topic, a, b)
            # Compare two substantive sources before reference-only links. Multiple
            # literal variants and independently located rows strengthen a candidate.
            quality = []
            for src in (a, b):
                side = [f for f in facts if f["source"] == src and f["role"] == "data"]
                labels = {f["label"].casefold() for f in side}
                quality.append((bool(side), len(labels)))
            score = sum(n for _, n in quality) + 10 * sum(bool(x) for x, _ in quality)
            self.db.execute(
                """INSERT INTO cases VALUES (?,?,?,?,?,1,?,?,?)
                ON CONFLICT(id) DO UPDATE SET version=version+1,updated=excluded.updated,
                priority=excluded.priority""",
                (
                    key,
                    self.revision,
                    topic,
                    a,
                    b,
                    time.time(),
                    json.dumps(origin),
                    score,
                ),
            )

    def material(self, topic, a, b):
        return [
            json.loads(r[0])
            for r in self.db.execute(
                "SELECT data FROM readings WHERE rev=? AND topic=? AND src IN (?,?) ORDER BY id",
                (self.revision, topic, a, b),
            )
        ]

    def claim(self, lease=600):
        now = time.time()
        with self.write():
            case = self.db.execute(
                """SELECT c.* FROM cases c WHERE c.rev=? AND NOT EXISTS (
                SELECT 1 FROM attempts t WHERE t.case_id=c.id AND
                ((t.finished IS NULL AND t.expires>?) OR (t.version=c.version AND t.finished IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM retries r WHERE r.prior_token=t.token))))
                ORDER BY c.priority DESC,c.updated,c.id LIMIT 1""",
                (self.revision, now),
            ).fetchone()
            if case is None:
                return None
            facts = self.material(case["topic"], case["a"], case["b"])
            token = uuid4().hex
            self.db.execute(
                "INSERT INTO attempts VALUES(?,?,?,?,?,NULL,?,NULL)",
                (
                    case["id"],
                    case["version"],
                    token,
                    now,
                    now + lease,
                    json.dumps([f["id"] for f in facts]),
                ),
            )
            return {**dict(case), "token": token, "facts": facts}

    def finish(self, case, result):
        with self.write():
            change = self.db.execute(
                """UPDATE attempts SET finished=?,result=? WHERE token=? AND
                case_id=? AND version=? AND finished IS NULL AND expires>?""",
                (
                    time.time(),
                    json.dumps(result, ensure_ascii=False),
                    case["token"],
                    case["id"],
                    case["version"],
                    time.time(),
                ),
            )
            if not change.rowcount:
                raise ValueError("expired or stale comparison token")

    def retry(self, case_id, version, reason):
        """Grant one retry after the caller reconciles the gateway/budget. Never discard evidence."""
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("a reconciled retry reason is required")
        with self.write():
            attempt = self.db.execute(
                """
                SELECT t.token,t.result,t.finished FROM cases c JOIN attempts t ON c.id=t.case_id
                WHERE c.rev=? AND c.id=? AND c.version=? AND t.version=c.version
                ORDER BY t.leased DESC LIMIT 1""",
                (self.revision, case_id, version),
            ).fetchone()
            if not attempt or attempt["finished"] is None:
                raise ValueError("there is no finished current attempt")
            if json.loads(attempt["result"]).get("state") not in {
                "open",
                "deferred",
                "pending",
                "disputed",
            }:
                raise ValueError("retry requires unresolved work")
            self.db.execute(
                "INSERT OR IGNORE INTO retries VALUES(?,?)",
                (attempt["token"], reason.strip()),
            )

    def history(self, case_id):
        rows = self.db.execute(
            """SELECT t.* FROM attempts t JOIN cases c ON c.id=t.case_id
            WHERE c.rev=? AND c.id=? ORDER BY t.leased,t.token""",
            (self.revision, case_id),
        )
        return [
            {
                **dict(row),
                "inputs": json.loads(row["inputs"]),
                "result": json.loads(row["result"]) if row["result"] else None,
            }
            for row in rows
        ]

    def snapshot(self):
        cases = []
        for row in self.db.execute(
            "SELECT * FROM cases WHERE rev=? ORDER BY id", (self.revision,)
        ):
            attempt = self.db.execute(
                """SELECT * FROM attempts WHERE case_id=? AND version=?
                ORDER BY leased DESC LIMIT 1""",
                (row["id"], row["version"]),
            ).fetchone()
            result = (
                json.loads(attempt["result"]) if attempt and attempt["result"] else {}
            )
            cases.append(
                {
                    **dict(row),
                    "origin": json.loads(row["origin"]),
                    "state": result.get("state", "pending"),
                    "basis": json.loads(attempt["inputs"]) if attempt else [],
                    "result": result,
                }
            )
        return cases

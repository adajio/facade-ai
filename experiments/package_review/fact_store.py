"""Durable observation, review, and engineer-export ledger for the package pilot."""

import json
import sqlite3
from contextlib import contextmanager


_ID_FIELDS = {
    "observation": "observation_id",
    "review": "review_id",
    "recommendation": "recommendation_id",
    "decision": "decision_id",
}
_TEXT_FIELDS = {
    "observation": ("fact_id", "package_revision", "statement", "scope", "origin"),
    "review": ("observation_id", "reviewer", "verdict", "rationale"),
    "recommendation": ("package_revision", "text"),
    "decision": ("package_revision", "engineer", "rationale"),
}
_SOURCE_FIELDS = ("source_id", "source_revision", "locator", "receipt")
_VERDICTS = {"confirmed", "unresolved", "disputed", "rejected"}
_EXTERNAL_BASES = ("confirmed_shortage", "confirmed_conflict")
_GAP_BASES = ("explicit_non_delivery", "exhaustive_inventory")


def _json(value):
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))


def _require_text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a nonempty string")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ValueError(f"{field} must be valid UTF-8 text") from None


def _require_ids(value, field, *, allow_empty=False):
    if not isinstance(value, list) or (not value and not allow_empty):
        raise ValueError(f"{field} must be a {'list' if allow_empty else 'nonempty list'} of IDs")
    for item in value:
        _require_text(item, field)
    if len(set(value)) != len(value):
        raise ValueError(f"{field} must contain distinct IDs")


def _places(sources):
    return {tuple(row[key] for key in _SOURCE_FIELDS[:3]) for row in sources}


def _require_sources(sources):
    if not isinstance(sources, list):
        raise ValueError("sources must be a list")
    for source in sources:
        if not isinstance(source, dict) or set(source) != set(_SOURCE_FIELDS):
            raise ValueError("each source requires source_id, source_revision, locator, receipt")
        for field in _SOURCE_FIELDS:
            _require_text(source[field], field)


def _heads(records, id_field):
    replaced = {row.get("supersedes") for row in records}
    return [row for row in records if row[id_field] not in replaced]


class FactStore:
    """Append-only SQLite ledger. Use one instance per thread, with an optional context manager."""

    def __init__(self, path):
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                id TEXT NOT NULL,
                revision TEXT NOT NULL,
                payload TEXT NOT NULL,
                UNIQUE (kind, id)
            );
            CREATE INDEX IF NOT EXISTS events_revision_kind ON events (revision, kind, seq);
            CREATE TABLE IF NOT EXISTS invalid_records (
                seq INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                revision TEXT NOT NULL,
                payload TEXT NOT NULL,
                reason TEXT NOT NULL,
                UNIQUE (kind, payload, reason)
            );
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

    def _event(self, kind, record_id):
        return self._db.execute(
            "SELECT revision, payload FROM events WHERE kind = ? AND id = ?", (kind, record_id)
        ).fetchone()

    def _records(self, kind, revision, through=None):
        sql = "SELECT payload FROM events WHERE kind = ? AND revision = ?"
        params = (kind, revision)
        if through is not None:
            sql += " AND seq <= ?"
            params += (through,)
        cursor = self._db.execute(sql + " ORDER BY seq", params)
        return [json.loads(payload) for (payload,) in cursor]

    def _record(self, kind, payload):
        id_field = _ID_FIELDS[kind]
        record_id = payload.get(id_field) if isinstance(payload, dict) else None
        record_id = record_id if isinstance(record_id, str) else None
        explicit_revision = payload.get("package_revision") if isinstance(payload, dict) else None
        revision = explicit_revision if isinstance(explicit_revision, str) else ""
        with self._transaction(write=True):
            try:
                raw = _json(payload)
            except (TypeError, ValueError, RecursionError):
                raw = _json({"non_json_repr": repr(payload)})
                return self._invalid(kind, revision, record_id, raw, "payload must be JSON-compatible")
            try:
                if not isinstance(payload, dict):
                    raise ValueError("payload must be an object")
                _require_text(record_id, id_field)
                if kind == "review":
                    _require_text(payload.get("observation_id"), "observation_id")
                    target = self._event("observation", payload["observation_id"])
                    if target:
                        revision = target[0]
                for field in _TEXT_FIELDS[kind]:
                    _require_text(payload.get(field), field)
                previous = self._event(kind, record_id)
                if previous:
                    if previous[1] == raw:
                        return {"status": "duplicate", "id": record_id}
                    raise ValueError("ID already holds a different immutable record")
                if kind == "review" and explicit_revision is not None and explicit_revision != revision:
                    raise ValueError("review package_revision differs from its observation")
                self._validate(kind, revision, payload)
            except ValueError as exc:
                return self._invalid(kind, revision, record_id, raw, str(exc))
            self._db.execute(
                "INSERT INTO events (kind, id, revision, payload) VALUES (?, ?, ?, ?)",
                (kind, record_id, revision, raw),
            )
            return {"status": "stored", "id": record_id}

    def _invalid(self, kind, revision, record_id, raw, reason):
        try:
            revision.encode("utf-8")
        except UnicodeError:
            revision = ""
        self._db.execute(
            "INSERT OR IGNORE INTO invalid_records (kind, revision, payload, reason) VALUES (?, ?, ?, ?)",
            (kind, revision, raw, reason),
        )
        return {"status": "invalid", "id": record_id, "reason": reason}

    @staticmethod
    def _check_parent(kind, record, head):
        predecessor = record.get("supersedes")
        if predecessor != (head[_ID_FIELDS[kind]] if head else None):
            raise ValueError(f"supersedes must identify the current {kind} revision")

    def _validate(self, kind, revision, row):
        if kind in ("observation", "review"):
            _require_sources(row.get("sources"))
        if kind == "observation":
            self._check_observation_basis(revision, row)
            revisions = [r for r in self._records(kind, revision) if r["fact_id"] == row["fact_id"]]
            current = _heads(revisions, "observation_id")
            self._check_parent(kind, row, current[0] if current else None)
        elif kind == "review":
            target = self._event("observation", row["observation_id"])
            if not target:
                raise ValueError("review references an unknown observation")
            observation = json.loads(target[1])
            if row["reviewer"].strip() == observation["origin"].strip():
                raise ValueError("reviewer must differ from the observation origin")
            if row["verdict"] not in _VERDICTS:
                raise ValueError("unknown review verdict")
            if row["verdict"] == "confirmed":
                expected = _places(observation["sources"])
                if not expected or not expected <= _places(row["sources"]):
                    raise ValueError("confirmation requires matching checked places for every observation source")
            revisions = [r for r in self._records(kind, revision)
                         if r["observation_id"] == row["observation_id"]
                         and r["reviewer"].strip() == row["reviewer"].strip()]
            current = _heads(revisions, "review_id")
            self._check_parent(kind, row, current[0] if current else None)
        elif kind == "recommendation":
            _require_ids(row.get("basis_observation_ids"), "basis_observation_ids")
            if row.get("basis_kind") not in (*_EXTERNAL_BASES, None):
                raise ValueError("unknown recommendation basis_kind")
            for observation_id in row["basis_observation_ids"]:
                target = self._event("observation", observation_id)
                if not target or target[0] != revision:
                    raise ValueError("recommendation requires observations in the same package revision")
        elif kind == "decision":
            _require_ids(row.get("recommendation_ids"), "recommendation_ids", allow_empty=True)
            current = _heads(self._records(kind, revision), "decision_id")
            self._check_parent(kind, row, current[0] if current else None)
            facts = self._facts(revision)
            eligibility = self._recommendations(revision, facts)
            allowed = {r["recommendation_id"] for r in eligibility if r["eligible_for_review"]}
            if not set(row["recommendation_ids"]) <= allowed:
                raise ValueError("engineer must select recommendations with current confirmed shortage or conflict bases")

    def _check_observation_basis(self, revision, row):
        parent_id = row.get("derived_from")
        if parent_id is not None:
            _require_text(parent_id, "derived_from")
            parent = self._event("observation", parent_id)
            if not parent or parent[0] != revision or json.loads(parent[1])["fact_id"] == row["fact_id"]:
                raise ValueError("derived_from must identify a separate observation in the same package revision")
        if row.get("finding") not in (*_EXTERNAL_BASES, None):
            raise ValueError("unknown observation finding")
        if row.get("finding") == "confirmed_shortage" and row.get("gap_basis") not in _GAP_BASES:
            raise ValueError("confirmed_shortage requires explicit_non_delivery or exhaustive_inventory")

    def record_observation(self, payload):
        return self._record("observation", payload)

    def record_review(self, payload):
        return self._record("review", payload)

    def record_letter_recommendation(self, payload):
        return self._record("recommendation", payload)

    def record_engineer_decision(self, payload):
        """Persist a caller-authorized engineer action. Never call with model-generated decisions."""
        return self._record("decision", payload)

    def history(self, package_revision=None):
        """Return accepted immutable events, including superseded records, in commit order."""
        sql = "SELECT seq, kind, revision, payload FROM events"
        params = ()
        if package_revision is not None:
            sql += " WHERE revision = ?"
            params = (package_revision,)
        return [dict(seq=seq, kind=kind, package_revision=revision, record=json.loads(raw))
                for seq, kind, revision, raw in self._db.execute(sql + " ORDER BY seq", params)]

    def invalid_records(self, package_revision=None):
        """Show quarantined submissions, including unassigned records when no revision is selected."""
        sql = "SELECT seq, kind, revision, payload, reason FROM invalid_records"
        params = ()
        if package_revision is not None:
            sql += " WHERE revision = ?"
            params = (package_revision,)
        return [dict(seq=seq, kind=kind, package_revision=revision or None, record=json.loads(raw), reason=reason)
                for seq, kind, revision, raw, reason in self._db.execute(sql + " ORDER BY seq", params)]

    def _facts(self, revision, through=None):
        reviews = {}
        for row in _heads(self._records("review", revision, through), "review_id"):
            reviews.setdefault(row["observation_id"], []).append(row)
        facts = []
        for observation in _heads(self._records("observation", revision, through), "observation_id"):
            checked = reviews.get(observation["observation_id"], [])
            verdicts = {row["verdict"] for row in checked}
            if "disputed" in verdicts or {"confirmed", "rejected"} <= verdicts:
                status = "disputed"
            elif "unresolved" in verdicts:
                status = "unresolved"
            elif "rejected" in verdicts:
                status = "rejected"
            elif "confirmed" in verdicts:
                status = "confirmed"
            elif not observation["sources"]:
                status = "incomplete"
            else:
                status = "unresolved"
            facts.append({**observation, "status": status, "reviews": checked})
        return facts

    def _recommendations(self, revision, facts):
        confirmed = {row["observation_id"]: row for row in facts if row["status"] == "confirmed"}
        recommendations = []
        for row in self._records("recommendation", revision):
            basis = set(row["basis_observation_ids"])
            kind = row.get("basis_kind")
            eligible = kind in _EXTERNAL_BASES and basis <= confirmed.keys() and any(
                confirmed[item].get("finding") == kind for item in basis
            )
            recommendations.append({**row, "approval": "unapproved", "eligible_for_review": eligible})
        return recommendations

    @staticmethod
    def _basis_review_ids(facts, recommendations):
        basis_ids = {item for row in recommendations for item in row["basis_observation_ids"]}
        return {review["review_id"] for fact in facts if fact["observation_id"] in basis_ids
                for review in fact["reviews"]}

    def _decision_basis_is_current(self, revision, decision, facts, selected):
        sequence, = self._db.execute(
            "SELECT seq FROM events WHERE kind = ? AND id = ?", ("decision", decision["decision_id"])
        ).fetchone()
        earlier_facts = self._facts(revision, through=sequence)
        return self._basis_review_ids(earlier_facts, selected) == self._basis_review_ids(facts, selected)

    def export_engineer(self, package_revision, summary=None):
        """Build a consistent snapshot. Summary text never drives the fact or letter tables."""
        _require_text(package_revision, "package_revision")
        if summary is not None and not isinstance(summary, str):
            raise ValueError("summary must be a string or None")
        with self._transaction():
            facts = self._facts(package_revision)
            recommendations = self._recommendations(package_revision, facts)
            decisions = _heads(self._records("decision", package_revision), "decision_id")
            approved = {"status": "awaiting_engineer", "decision": None, "items": []}
            if decisions:
                decision = decisions[0]
                eligible = {row["recommendation_id"]: row for row in recommendations if row["eligible_for_review"]}
                selected = decision["recommendation_ids"]
                approved["decision"] = decision
                if set(selected) <= eligible.keys() and self._decision_basis_is_current(
                    package_revision, decision, facts, [eligible[item] for item in selected]
                ):
                    approved["status"] = "approved" if selected else "closed_without_letter"
                    approved["items"] = [{**eligible[item], "approval": "approved"} for item in selected]
                else:
                    approved["status"] = "review_required"
            return {
                "package_revision": package_revision,
                "summary": summary,
                "confirmed_facts": [row for row in facts if row["status"] == "confirmed"],
                "open_facts": [row for row in facts if row["status"] != "confirmed"],
                "letter_recommendations": recommendations,
                "approved_letter": approved,
                "invalid_records": self.invalid_records(package_revision),
            }

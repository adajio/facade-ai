"""Persist deliveries, question reviews, immutable assessments and engineer selections."""

import json
from copy import deepcopy
from pathlib import Path

from .engineering_questions import (
    disposition,
    letter_citations,
    letter_text,
    matching_evidence,
    reader_positions,
    scope_summary,
)
from .reading_flow import revision_runner
from .research import digest, save


def load(path, default=None):
    return json.loads(path.read_bytes()) if path.exists() else default


class QuestionProject:
    def __init__(self, directory, project_id, profile, models):
        self.root = Path(directory) / "engineering"
        self.root.mkdir(parents=True, exist_ok=True)
        self.project_id = project_id
        self.profile = profile
        self.models = models
        questions = profile["questions"]
        ids = [q["id"] for q in questions]
        if (
            not project_id
            or not questions
            or len(set(ids)) != len(ids)
            or any(
                not q["id"]
                or not q["scope"]
                or not q["subject"]
                or not q["required_roles"]
                for q in questions
            )
        ):
            raise ValueError(
                "a project and distinct scoped questions with required roles are required"
            )

    def lock(self):
        return revision_runner(self.root, "question-project")

    def begin(self, revision):
        identity = {"project": self.project_id, "models": list(self.models)}
        owner_file = self.root / "identity.json"
        if load(owner_file, identity) != identity:
            raise ValueError(
                "project directory belongs to another project or model profile"
            )
        save(owner_file, identity)
        deliveries = load(self.root / "deliveries.json", [])
        if revision not in deliveries:
            deliveries.append(revision)
        save(self.root / "current.json", {"state": "processing", "delivery": revision})
        save(self.root / "deliveries.json", deliveries)
        return revision

    def record(self, directory, revision, units):
        expected = load(directory / "upload-manifest.json")
        evidence = []
        for f in load(directory / "readings.json"):
            # The reader owns these quotes. Reconstruct them from original source rows.
            lines = units.get(f["unit"], [])
            if any(i >= len(lines) for i in f["lines"]) or f.get("original_lines") != [
                lines[i] for i in f["lines"]
            ]:
                raise ValueError("reader no longer reproduces the cited original lines")
            evidence.append(f)
        save(
            self.root / revision / "input.json",
            {
                "revision": revision,
                "manifest": expected,
                "metadata": load(directory / "document-metadata.json", {}),
                "coverage": load(directory / "coverage.json"),
                "facts": evidence,
            },
        )

    def material(self, deliveries):
        facts = {}
        document_versions = {}
        held = set()
        eligible = True
        for revision in deliveries:
            item = load(self.root / revision / "input.json")
            if item is None:
                held.add("*")
                eligible = False
                continue
            coverage = item["coverage"]
            eligible = eligible and coverage["comparison_eligible"]
            by_hash = {}
            for name, checksum in item["manifest"].items():
                configured = self.profile.get("documents", {}).get(name)
                received = item.get("metadata", {}).get(name)
                if (
                    configured
                    and received
                    and any(
                        configured.get(field) != received.get(field)
                        for field in ("scope", "role", "sha256")
                    )
                ):
                    held.add("*")
                    continue
                meta = configured or received or {}
                if (
                    meta.get("sha256") != checksum
                    or not meta.get("scope")
                    or not meta.get("role")
                ):
                    held.add("*")
                    continue
                if checksum in by_hash and by_hash[checksum] != meta:
                    held.add("*")
                    continue
                document_key = meta.get("document_key", name)
                previous = document_versions.get(document_key)
                if previous and previous[0] != checksum:
                    held.update({previous[1], meta["scope"]})
                document_versions[document_key] = (checksum, meta["scope"])
                by_hash[checksum] = meta
                counts = coverage["by_original"][checksum]
                if not counts["units"] or counts["fully_read"] != counts["units"]:
                    held.add(meta["scope"])
            for f in item["facts"]:
                meta = by_hash.get(f["source"])
                if meta:
                    facts[f["id"]] = {
                        **f,
                        "scope": meta["scope"],
                        "document_role": meta["role"],
                        "document": next(
                            n for n, h in item["manifest"].items() if h == f["source"]
                        ),
                    }
        return list(facts.values()), held, eligible

    def assess(self, compare, can_send, search=None, restore=None):
        deliveries = load(self.root / "deliveries.json")
        facts, held, eligible = self.material(deliveries)
        questions, proposals = [], []
        for question in self.profile["questions"]:
            search_error = None
            try:
                candidates = matching_evidence(question, facts, search)
            except Exception as exc:  # noqa: BLE001 - isolate retrieval failures to this question.
                candidates = matching_evidence(question, facts)
                search_error = str(exc) or "semantic_search_failed"
            # A changed question, model set or source lines requires a fresh review.
            key = digest([self.project_id, self.models, question, candidates])
            cache = self.root / "reviews" / (key + ".json")
            result = load(cache, {})
            blocked = "*" in held or question["scope"] in held or bool(search_error)
            case = {
                "id": key,
                "kind": "engineering_question",
                "question": question,
                "facts": candidates,
                "revision": deliveries[-1],
                "models": list(self.models),
                "token": key,
            }
            if result.get("state") in {"unknown", "dispatching"} and restore:
                try:
                    recovered = restore(deepcopy(case))
                    if recovered is not None and not isinstance(recovered, dict):
                        raise TypeError("invalid gateway reconciliation")
                except Exception as exc:  # noqa: BLE001 - unrelated questions can still complete.
                    recovered = None
                    result = {**result, "restore_error": str(exc)}
                    save(cache, result)
                if recovered and recovered.get("receipt"):
                    if isinstance(recovered.get("reviews"), dict):
                        result = {"state": "returned", "response": recovered}
                        save(cache, result)
                    elif recovered.get("state") == "not_sent":
                        save(self.root / "reconciled" / (key + ".json"), recovered)
                        result = {"state": "not_sent"}
                        save(cache, result)
            if (
                not blocked
                and candidates
                and eligible
                and result.get("state") in {None, "not_sent"}
                and can_send()
            ):
                # Any crash after admission leaves a record for gateway reconciliation.
                save(cache, {"state": "dispatching", "case": key})
                try:
                    response = compare(deepcopy(case))
                    if not isinstance(response, dict):
                        raise TypeError("question review must be an object")
                    result = {"state": "returned", "response": response}
                except Exception as exc:  # noqa: BLE001 - retain an unknown gateway outcome.
                    result = {"state": "unknown", "error": str(exc)}
                save(cache, result)
            reviews = result.get("response", {}).get("reviews", {})
            status, basis, reason = disposition(
                question, reviews, candidates, self.models
            )
            if blocked or not candidates:
                status, basis, reason = (
                    "needs_review",
                    [],
                    (
                        "incomplete_or_unclassified_sources"
                        if blocked
                        else "no_evidence"
                    ),
                )
            elif not reviews:
                reason = result.get("state") or (
                    "waiting_for_gateway"
                    if eligible
                    else "waiting_for_primary_coverage"
                )
            if search_error:
                reason = "semantic_search_failed: " + search_error
            row = {
                "id": question["id"],
                "subject": question["subject"],
                "scope": question["scope"],
                "status": status,
                "basis": basis,
                "evidence": candidates,
                "reason": reason,
                "case_id": key,
                "reviews": reviews,
                "positions": reader_positions(reviews, candidates, self.models),
                "gateway_diagnostic": result.get("restore_error")
                or result.get("error"),
            }
            questions.append(row)
            if (
                status in {"missing", "conflict"}
                and question.get("external") is True
                and question.get("request_text")
            ):
                proposals.append(
                    {
                        "question_id": question["id"],
                        "text": question["request_text"],
                        "basis": basis,
                        "citations": letter_citations(
                            reviews[self.models[0]], candidates
                        ),
                    }
                )
        report = {
            "project": self.project_id,
            "revision": deliveries[-1],
            "deliveries": deliveries,
            "profile_id": digest(self.profile),
            "questions": questions,
            "scopes": scope_summary(questions),
            "letter": proposals,
            "decision": "awaiting_engineer",
        }
        report["assessment_id"] = digest(report)
        save(self.root / "snapshots" / (report["assessment_id"] + ".json"), report)
        save(self.root / deliveries[-1] / "assessment.json", report)
        save(
            self.root / "current.json",
            {"state": "ready", "assessment_id": report["assessment_id"]},
        )
        return report

    def confirm(self, assessment_id, question_ids, engineer):
        with self.lock():
            identity = load(self.root / "identity.json", {})
            if (
                identity.get("project") != self.project_id
                or not isinstance(engineer, str)
                or not engineer.strip()
            ):
                raise ValueError("a project engineer is required")
            current = load(self.root / "current.json", {})
            if current != {"state": "ready", "assessment_id": assessment_id}:
                raise ValueError("assessment is no longer current")
            report = load(self.root / "snapshots" / (assessment_id + ".json"))
            selected = set(question_ids)
            lines = [row for row in report["letter"] if row["question_id"] in selected]
            if selected != {row["question_id"] for row in lines}:
                raise ValueError(
                    "a selected question has no supported external request"
                )
            text = letter_text(lines)
            record = {
                "engineer": engineer,
                "assessment_id": assessment_id,
                "lines": lines,
                "text": text,
                "state": "draft" if lines else "no_letter",
                "sent": False,
            }
            save(self.root / "conclusions" / (digest(record) + ".json"), record)
            return record

"""A paired, source-addressed assessment on an immutable reader snapshot."""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from copy import copy, deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory

from .autonomy_trial import MODELS, RESEARCH, Trial
from .conflict_basis import VERIFY_CONFLICT
from .conflict_basis import sides as conflict_sides
from .delivery_proof import INQUIRY, common_attestation, validate_delivery
from .engineering_questions import letter_text, quoted_value
from .ordinary_intake import verify_originals
from .reading_flow import revision_runner
from .research import digest, save

POSITION = """
Добавь к каждому ответу reason — краткое объяснение для инженера и decisive —
список индексов (с 1) решающих цитат в evidence. Укажи именно определяющие
предметные строки, отдельно приведи контекст области/редакции в evidence.
Для conflict отметь решающие строки обеих сторон, для missing — действующее
основание нехватки; проверь весь пакет на досылку. Для needs_review укажи, что
конкретно мешает сделать вывод, и сохрани обе позиции, если они есть."""
ARBITER = """
Ты ведущий разбора одного спора. Обе позиции — гипотезы. Сверь их с оригиналами,
можешь открыть другие места через open. Проверь редакцию, область и возможное
опровержение. Укажи почему спор разрешим либо что осталось неизвестно. Верни
ответ только по переданному вопросу. Твой ответ ещё проверят оба читателя."""
RECHECK = """
Независимо проверь предложенный разбор одного спора. Возражай, если исходные
строки допускают иное прочтение. Можешь открыть другие места. Верни собственную
позицию только по переданному вопросу. Каждую решающую цитату ведущего проверь
по оригиналу. Если она действительно определяет твой вывод, отметь её в decisive.
Другие необходимые основания добавь отдельно; разрешено отвергнуть предложение."""


class PositionSession(Trial):
    def __init__(self, package, call, lead):
        super().__init__(package, call, lead)
        self.partial = {}
        self.drafts = {}

    def checked(self, obj, refs, require_all):
        # Preserve independently valid questions if a sibling keeps failing repair.
        answers = obj.get("answers")
        if isinstance(answers, list):
            ids = [a.get("question_id") for a in answers if isinstance(a, dict)]
            for answer in answers:
                if (
                    not isinstance(answer, dict)
                    or ids.count(answer.get("question_id")) != 1
                ):
                    continue
                try:
                    self.validate_positions({"answers": [answer]}, refs, False)
                except (ValueError, KeyError, TypeError):
                    qid = answer.get("question_id")
                    if isinstance(qid, str):
                        try:
                            Trial.checked(self, {"answers": [answer]}, refs, False)
                        except (TypeError, ValueError, KeyError):
                            # An ungrounded update cannot revoke a previously validated position.
                            pass
                        else:
                            draft = {
                                k: answer.get(k)
                                for k in (
                                    "question_id",
                                    "status",
                                    "evidence",
                                    "request",
                                )
                            }
                            self.drafts[qid] = draft
                            previous = self.partial.get(qid)
                            if previous and (
                                any(previous.get(k) != v for k, v in draft.items())
                                or previous.get("decisive") != answer.get("decisive")
                            ):
                                self.partial.pop(qid, None)
                else:
                    self.partial[answer["question_id"]] = answer
                    self.drafts.pop(answer["question_id"], None)
        return self.validate_positions(obj, refs, require_all)

    def validate_positions(self, obj, refs, require_all):
        result = super().checked(obj, refs, require_all)
        for row in result["answers"]:
            if not isinstance(row.get("reason"), str) or not row["reason"].strip():
                raise ValueError("explain this position in reason")
            indexes = row.get("decisive")
            if not isinstance(indexes, list) or any(
                type(n) is not int or not 1 <= n <= len(row["evidence"])
                for n in indexes
            ):
                raise ValueError(
                    "decisive must list valid evidence indices starting at 1"
                )
            if row["status"] != "needs_review" and not indexes:
                raise ValueError("identify the decisive source lines")
            if (
                row["status"] == "conflict"
                and len({(e["unit"], e["line"]) for e in decisive(row)}) < 2
            ):
                raise ValueError("identify both opposing source lines")
            if row["status"] == "missing" and refs != set(self.units):
                raise ValueError(
                    "unopened sources may contain the alleged missing item; open them or hold"
                )
        return result


class ConflictSession(PositionSession):
    def validate_positions(self, obj, refs, require_all):
        result = super().validate_positions(obj, refs, require_all)
        for row in result["answers"]:
            if row["status"] == "conflict":
                conflict_sides(row, self.owners, self.units)
            elif row["status"] != "needs_review":
                raise ValueError(
                    "confirm both opposed current values or explain the remaining uncertainty"
                )
        return result


def recoverable_format_hold(branch):
    if not branch["report"].get("held"):
        return False
    if "hold_kind" in branch:
        return branch["hold_kind"] == "invalid_output"
    # Migrate older receipts only if their terminal format error is identifiable.
    events = branch.get("events", [])
    return bool(
        events
        and events[-1]["action"] == "invalid"
        and events[-1].get("reason") == branch["report"]["held"]
    )


class DeliverySession(PositionSession):
    def validate_positions(self, obj, refs, require_all):
        result = super().validate_positions(obj, refs, require_all)
        for row in result["answers"]:
            validate_delivery(row)
        return result


def decisive(row):
    return [row["evidence"][i - 1] for i in row["decisive"]]


def shared_ground(rows):
    """Same source line and overlapping verbatim passage across all positions."""

    def matches(a, b):
        return (a["unit"], a["line"]) == (b["unit"], b["line"]) and (
            a["quote"] in b["quote"] or b["quote"] in a["quote"]
        )

    groups = [decisive(row) for row in rows]
    return [
        e
        for e in groups[0]
        if all(any(matches(e, other) for other in group) for group in groups[1:])
    ]


def disposition(rows):
    if not all(rows):
        return "needs_review", "reader_unavailable"
    if len({row["status"] for row in rows}) > 1:
        return "needs_review", "different_status"
    status = rows[0]["status"]
    if status == "needs_review":
        anchors = [{(e["unit"], e["line"]) for e in row["evidence"]} for row in rows]
        if all(anchors) and not set.intersection(*anchors):
            return status, "different_decisive_evidence"
        return status, "shared_uncertainty"
    shared = shared_ground(rows)
    # A common heading or one side of a contradiction cannot settle different
    # decisive grounds. Extra contextual evidence remains available separately.
    for i, row in enumerate(rows):
        common = shared_ground([row, *rows[:i], *rows[i + 1 :]])
        if len(common) != len(decisive(row)):
            return "needs_review", "different_decisive_evidence"
    if status == "conflict" and len({(e["unit"], e["line"]) for e in shared}) < 2:
        return "needs_review", "different_decisive_evidence"
    return status, "grounded_agreement"


def grounded_text(request, status, question, evidence):
    """When a generated measurement is unsupported, use the addressed question."""
    measurement = re.compile(
        r"(?<!\w)\d+(?:[.,]\d+)?\s*(?:мм|см|м|кг|шт|°)(?!\w)", re.IGNORECASE
    )

    def measures(text):
        return {
            quoted_value(re.sub(r"\s+", "", v.casefold()).replace(",", "."))
            for v in measurement.findall(text)
        }

    source = " ".join(
        [question["subject"], question["scope"], *(e["quote"] for e in evidence)]
    )
    if measures(request) <= measures(source):
        return request
    action = (
        "согласовать применимое решение"
        if status == "conflict"
        else "предоставить недостающие сведения"
    )
    return f"Просим {action} по вопросу «{question['subject']}» для области «{question['scope']}»."


class DisputeReview:
    def __init__(self, package, call, lead, *, checkpoint=None, route_revision=None):
        if lead not in MODELS:
            raise ValueError("unknown lead")
        self.package, self.call, self.lead = deepcopy(package), call, lead
        self.snapshot = digest(package)
        self.held_this_pair = None
        self.checkpoint = None
        if checkpoint is not None:
            if not route_revision:
                raise ValueError(
                    "checkpoint requires the identity of both gateway routes and settings"
                )
            self.checkpoint = Path(checkpoint) / digest(
                ["0.19", self.snapshot, route_revision]
            )
            self.checkpoint.mkdir(parents=True, exist_ok=True)
        self.owners = Trial(package, call, lead).owners

    @classmethod
    def from_upload(
        cls,
        files,
        expected,
        *,
        reader,
        stage,
        questions,
        call,
        lead,
        checkpoint=None,
        route_revision=None,
    ):
        """Bind a complete current delivery to the same manifest used by ordinary intake.

        A caller supplying a supplement passes the assembled current full snapshot.
        The reader adapter returns one addressed document for each verified original.
        """
        revision = verify_originals(files, expected)
        docs = []
        for name, path in sorted(files.items()):
            doc = reader(path)
            if (
                doc["id"] != name
                or not doc["units"]
                or any(
                    not u["lines"]
                    or not all(isinstance(line, str) for line in u["lines"])
                    for u in doc["units"]
                )
            ):
                raise ValueError("incomplete source inventory: " + name)
            docs.append(doc)
        verify_originals(files, expected)
        return cls(
            {
                "stage": stage,
                "questions": questions,
                "docs": docs,
                "revision": revision,
                "manifest": expected,
            },
            call,
            lead,
            checkpoint=checkpoint,
            route_revision=route_revision,
        )

    def run(self, *, mediate=True):
        readers = self.independent()
        return {**self.assess(readers, mediate=mediate), "readers": readers}

    def branch(
        self,
        model,
        lane,
        prompt,
        question=None,
        opened=(),
        reports=(),
        session_type=PositionSession,
    ):
        args = (
            model,
            lane,
            prompt,
            question,
            sorted(opened),
            list(reports),
            session_type,
        )
        if self.checkpoint is None:
            return self._read_branch(*args)
        key = digest([*args[:-1], session_type.__name__])
        path = self.checkpoint / (key + ".json")
        with revision_runner(self.checkpoint, key):
            if self.held_this_pair is not None and key in self.held_this_pair:
                return deepcopy(self.held_this_pair[key])
            if path.exists():
                return json.loads(path.read_bytes())
            # The gateway reconciles its own exact wire/charge if a process dies
            # inside an operation. Only settled model outcomes are cached here.
            result = self._read_branch(*args)
            if result.get("hold_kind") != "gateway_unreconciled":
                save(path, result)
            elif self.held_this_pair is not None:
                self.held_this_pair[key] = deepcopy(result)
            return result

    def _read_branch(
        self, model, lane, prompt, question, opened, reports, session_type
    ):
        package = (
            self.package
            if question is None
            else {**self.package, "questions": [question]}
        )
        trial = session_type(package, self.call, self.lead)
        hold_kind = "invalid_output"
        try:
            report, receipts = trial.session(
                model,
                lane,
                prompt + POSITION,
                "Проверь все предъявленные вопросы.",
                shared=opened,
                reports=reports,
            )
        except (RuntimeError, OSError) as exc:
            # The injected gateway owns billing reconciliation; never auto-resend here.
            hold_kind = "gateway_unreconciled"
            report = {"answers": [], "held": str(exc)}
            receipts = set(opened) | trial.opened
        if report.get("held"):
            report["answers"] = list(trial.partial.values())
            if trial.drafts:
                report["drafts"] = trial.drafts
        return {
            "model": model,
            "lane": lane,
            "snapshot": self.snapshot,
            "report": report,
            "opened": sorted(receipts),
            "events": trial.events,
            **({"hold_kind": hold_kind} if report.get("held") else {}),
        }

    def independent(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(
                pool.map(
                    lambda model: self.branch(model, "read-" + model, RESEARCH), MODELS
                )
            )

    @staticmethod
    def vote(branch, qid):
        return next(
            (r for r in branch["report"]["answers"] if r["question_id"] == qid), None
        )

    def address(self, entry):
        return {
            "document": self.owners[entry["unit"]],
            "unit": entry["unit"],
            "rows": [entry["line"]],
            "quote": entry["quote"],
        }

    def assess(self, readers, *, mediate):
        if [b["model"] for b in readers] != list(MODELS) or any(
            b["snapshot"] != self.snapshot or b["lane"] != "read-" + b["model"]
            for b in readers
        ):
            raise ValueError(
                "independent readings belong to a different snapshot or branch"
            )
        questions, letter, sessions = [], [], []
        for question in self.package["questions"]:
            qid = question["id"]
            active = list(readers)
            all_branches = list(readers)
            for i, previous in enumerate(readers):
                if not self.vote(previous, qid) and recoverable_format_hold(previous):
                    prompt = (
                        RESEARCH
                        + "\nПродолжи своё первичное чтение только по этому вопросу. "
                        "Используй открытые тобой оригиналы. Обязательно укажи reason "
                        "для этого ответа: что следует из цитат и почему. "
                        "Диагностика предыдущего ответа: " + previous["report"]["held"]
                    )
                    draft = previous["report"].get("drafts", {}).get(qid)
                    resumed = self.branch(
                        previous["model"],
                        "resume-" + qid + "-" + previous["model"],
                        prompt,
                        question,
                        previous["opened"],
                        [{"own_unfinished_position": draft}] if draft else (),
                    )
                    active[i] = resumed
                    sessions.append(resumed)
                    all_branches.append(resumed)
            sides = [self.vote(b, qid) for b in active]
            status, trigger = disposition(sides)
            reason, final = trigger, sides
            if mediate and trigger in {
                "different_status",
                "different_decisive_evidence",
            }:
                # Deliver the originals already requested by either independent reader.
                opened = {unit for b in active for unit in b["opened"]}
                arguments = [
                    {"model": b["model"], "position": side}
                    for b, side in zip(active, sides)
                ]
                lead = self.branch(
                    self.lead, "mediate-" + qid, ARBITER, question, opened, arguments
                )
                sessions.append(lead)
                all_branches.append(lead)
                proposal = self.vote(lead, qid)
                reason = "mediator_unavailable"
                if proposal and proposal["status"] == "needs_review":
                    reason = "mediator_unresolved"
                elif proposal:
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        futures = [
                            pool.submit(
                                self.branch,
                                model,
                                "check-" + qid + "-" + model,
                                RECHECK,
                                question,
                                lead["opened"],
                                [*arguments, {"proposal": proposal}],
                            )
                            for model in MODELS
                        ]
                        checks = [future.result() for future in futures]
                    all_branches.extend(checks)
                    sessions.extend(checks)
                    final = [self.vote(b, qid) for b in checks]
                    status, reason = disposition([*final, proposal])
                    # Every proposed decisive line must survive both source checks.
                    if (
                        all(final)
                        and all(v["status"] == proposal["status"] for v in final)
                        and len(shared_ground([proposal, *final]))
                        == len(decisive(proposal))
                    ):
                        status, reason = (
                            proposal["status"],
                            "ratified_mediator_evidence",
                        )
                    elif (
                        proposal["status"] == "conflict"
                        and status == "needs_review"
                        and all(v and v["status"] == "conflict" for v in final)
                    ):
                        # Recheck the opposed source statements explicitly. Merely
                        # citing a contextual line doesn't establish agreement with it.
                        with ThreadPoolExecutor(max_workers=2) as pool:
                            futures = [
                                pool.submit(
                                    self.branch,
                                    b["model"],
                                    "opposed-" + qid + "-" + b["model"],
                                    VERIFY_CONFLICT,
                                    question,
                                    b["opened"],
                                    (),
                                    ConflictSession,
                                )
                                for b in checks
                            ]
                            grounded = [job.result() for job in futures]
                        sessions.extend(grounded)
                        all_branches.extend(grounded)
                        final = [self.vote(b, qid) for b in grounded]
                        if all(
                            v and v["status"] == "conflict" for v in final
                        ) and conflict_sides(final[0], self.owners) == conflict_sides(
                            final[1], self.owners
                        ):
                            status, reason = "conflict", "same_opposed_source_values"
                        else:
                            reason = (
                                "opposed_sources_unverified"
                                if all(final)
                                else "opposed_check_unavailable"
                            )
            # Attribute non-delivery to a direct source. Reading completeness and
            # agreement about an unknown value cannot establish this fact.
            if status == "missing" or (
                status == "needs_review"
                and all(sides)
                and any(s["status"] == "missing" for s in sides)
                and all(s["status"] in {"missing", "needs_review"} for s in sides)
                and all(
                    self.vote(b, qid) for b in [*active, *all_branches[len(readers) :]]
                )
            ):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    inquiries = [
                        pool.submit(
                            self.branch,
                            branch["model"],
                            "delivery-" + qid + "-" + branch["model"],
                            INQUIRY,
                            question,
                            branch["opened"],
                            (),
                            DeliverySession,
                        )
                        for branch in active
                    ]
                    receipts = [future.result() for future in inquiries]
                sessions.extend(receipts)
                all_branches.extend(receipts)
                final = [self.vote(b, qid) for b in receipts]
                if common_attestation(final):
                    status, reason = "missing", "current_non_delivery_attested"
                else:
                    status = "needs_review"
                    reason = (
                        "delivery_unverified"
                        if all(final)
                        else "delivery_check_unavailable"
                    )
            positions, evidence = [], []
            for b in all_branches:
                vote = self.vote(b, qid)
                quotes = [self.address(e) for e in vote["evidence"]] if vote else []
                positions.append(
                    {
                        "model": b["model"],
                        "lane": b["lane"],
                        "status": vote["status"] if vote else "unavailable",
                        "reason": vote["reason"] if vote else b["report"].get("held"),
                        "citations": quotes,
                        **(
                            {"delivery": vote["delivery"]}
                            if vote and "delivery" in vote
                            else {}
                        ),
                        "decisive_citations": [self.address(e) for e in decisive(vote)]
                        if vote
                        else [],
                    }
                )
                for quote in quotes:
                    if quote not in evidence:
                        evidence.append(quote)
            row = {
                "question_id": qid,
                "scope": question["scope"],
                "subject": question["subject"],
                "status": status,
                "trigger": trigger,
                "reason": reason,
                "positions": positions,
                "evidence": evidence,
                "request": None,
            }
            if status != "needs_review":
                row["decision_evidence"] = []
                for opinion in final:
                    for e in opinion["evidence"]:
                        citation = self.address(e)
                        if citation not in row["decision_evidence"]:
                            row["decision_evidence"].append(citation)
            else:
                row["decision_evidence"] = evidence.copy()
            if status in {"missing", "conflict"} and question.get("external", True):
                editor = final[MODELS.index(self.lead)]
                row["request"] = grounded_text(
                    editor["request"], status, question, row["decision_evidence"]
                )
                other = final[1 - MODELS.index(self.lead)]
                pins = decisive(editor)
                if reason == "same_opposed_source_values":
                    basis = editor["conflict_basis"]
                    pins = [
                        editor["evidence"][i - 1]
                        for i in dict.fromkeys(
                            [s["pin"] for s in basis["sides"]] + basis["applicability"]
                        )
                    ]
                accepted = [self.address(e) for e in pins]
                decisive_lines = {(c["unit"], c["rows"][0]) for c in accepted}
                for e in editor["evidence"]:
                    key = (e["unit"], e["line"])
                    if key in decisive_lines:
                        continue
                    if any(
                        (match["unit"], match["line"]) == key
                        and (
                            e["quote"] in match["quote"] or match["quote"] in e["quote"]
                        )
                        for match in other["evidence"]
                    ):
                        accepted.append({**self.address(e), "role": "context"})
                        decisive_lines.add(key)
                letter.append(
                    {"question_id": qid, "text": row["request"], "citations": accepted}
                )
            questions.append(row)
        return {
            "snapshot": self.snapshot,
            "documents": [
                {
                    "id": d["id"],
                    "title": d["title"],
                    "units": [{"id": u["id"], "title": u["title"]} for u in d["units"]],
                }
                for d in self.package["docs"]
            ],
            "questions": questions,
            "letter": letter,
            "draft": letter_text(letter),
            "decision": "awaiting_engineer",
            "sent": False,
            "sessions": sessions,
        }

    def run_pair(self):
        paired = copy(self)
        paired.held_this_pair = {}
        if self.checkpoint is None:
            with TemporaryDirectory() as directory:
                paired.checkpoint = Path(directory)
                return paired._assess_pair()
        return paired._assess_pair()

    def _assess_pair(self):
        readers = self.independent()
        return {
            "readers": readers,
            "baseline": self.assess(readers, mediate=False),
            "conditional": self.assess(readers, mediate=True),
        }

"""Configured ordinary-upload entry point for the evidence-driven reading profile."""

from pathlib import Path

from .intake_checks import compact_line
from .ordinary_intake import ordinary_upload
from .question_project import QuestionProject
from .reading_flow import reading_flow
from .research import digest
from .source_jobs import admit_source_item, reading_jobs


class PackageReading:
    """Configure the reader and gateway once at startup. The uploader supplies originals only.

    extract(job, original_lines) returns located observations or an explicit partial/deferred
    outcome. compare(case) receives an immutable evidence version and a unique attempt token.
    """

    def __init__(
        self,
        *,
        reader,
        models,
        extract,
        compare,
        gateway_available,
        publish,
        workers=6,
        restore_source=None,
        question_profile=None,
        project_id=None,
        semantic_search=None,
        restore_question=None,
    ):
        if len(models) != 2 or len(set(models)) != 2 or workers < 1:
            raise ValueError(
                "two independent readers and at least one worker are required"
            )
        if (question_profile is None) != (project_id is None):
            raise ValueError("engineering profile requires a project id")
        self.question_profile = question_profile
        self.project_id = project_id
        self.semantic_search = semantic_search
        self.restore_question = restore_question
        self.reader = reader
        self.models = tuple(models)
        self.extract = extract
        self.restore_source = restore_source
        self.compare = compare
        self.gateway_available = gateway_available
        self.publish = publish
        self.workers = workers

    def upload(self, files, expected, directory):
        if self.question_profile is None:
            return self._upload(files, expected, directory, self.process)
        project = QuestionProject(
            directory, self.project_id, self.question_profile, self.models
        )
        with project.lock():

            def process(folder, revision, units, owners, publish):
                def assess(current, cases, issues):
                    project.record(folder, current, units)
                    result = project.assess(
                        self.compare,
                        self.gateway_available,
                        self.semantic_search,
                        self.restore_question,
                    )
                    publish(current, result["questions"], issues)
                    return result

                return self.process(
                    folder, revision, units, owners, assess, source_only=True
                )

            return self._upload(files, expected, directory, process, project.begin)

    def confirm(self, directory, assessment_id, question_ids, engineer):
        if self.question_profile is None:
            raise ValueError("confirmation requires an engineering question profile")
        project = QuestionProject(
            directory, self.project_id, self.question_profile, self.models
        )
        return project.confirm(assessment_id, question_ids, engineer)

    def _upload(self, files, expected, directory, profile, on_verified=None):
        return ordinary_upload(
            files=files,
            expected=expected,
            folder=Path(directory),
            read=self.reader,
            readers=self.models,
            reading_profile=profile,
            on_verified=on_verified,
            scope="package-intake"
            if self.project_id is None
            else digest(["engineering", self.project_id]),
            publish=self.publish,
            survey=None,
            screen=None,
            inspect=None,
        )

    def process(
        self, directory, revision, units, owners, publish, *, source_only=False
    ):
        jobs = []
        for score, ref, window in reading_jobs(units, owners):
            work = digest([owners[ref], ref, window])
            for reader in self.models:
                jobs.append(
                    {
                        "job": work,
                        "model": reader,
                        "source": owners[ref],
                        "unit": ref,
                        "lines": [n for n, _ in window],
                        "priority": score,
                    }
                )

        def extract(job, adapter=self.extract):
            original = {i: units[job["unit"]][i] for i in job["lines"]}
            if source_only:
                job = {
                    **job,
                    "question_catalog": [
                        {k: q[k] for k in ("id", "subject", "scope")}
                        for q in self.question_profile["questions"]
                    ],
                }
            result = adapter(job, original)
            if (
                result is None
                and self.restore_source is not None
                and adapter is self.restore_source
            ):
                return None
            if isinstance(result, list):
                result = {"observations": result, "state": "read"}
            addressed, rejected = [], []
            presented = {i: compact_line(line) for i, line in original.items()}
            for fact in result["observations"]:
                if not isinstance(fact, dict) or not fact.get("receipt"):
                    rejected.append({"item": fact, "reason": "missing_receipt"})
                    continue
                located = admit_source_item(
                    [
                        fact.get("label"),
                        fact.get("lines"),
                        fact.get("role"),
                        fact.get("text"),
                    ],
                    original,
                    presented,
                )
                if located is None:
                    rejected.append(
                        {"item": fact, "reason": "ungrounded_label_or_address"}
                    )
                    continue
                addressed.append(
                    {
                        **fact,
                        **located,
                        **(
                            {"original_lines": [original[i] for i in located["lines"]]}
                            if source_only
                            else {}
                        ),
                        "source": job["source"],
                        "unit": job["unit"],
                        "job": job["job"],
                        "model": job["model"],
                        "revision": revision,
                    }
                )
            if rejected:
                result = {
                    **result,
                    "state": "partial",
                    "reason": "unadmitted_source_items",
                    "rejected": list(result.get("rejected", [])) + rejected,
                }
            return {**result, "observations": addressed}

        return reading_flow(
            directory,
            revision,
            jobs,
            extract,
            self.compare,
            self.gateway_available,
            publish,
            workers=self.workers,
            source_only=source_only,
            restore_source=(lambda j: extract(j, self.restore_source))
            if self.restore_source
            else None,
        )

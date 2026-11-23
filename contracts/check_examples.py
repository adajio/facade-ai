"""Проверка схем спецификации на синтетических данных, без обращения к сети."""

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

root = Path(__file__).resolve().parent
schemas = {path.name: json.loads(path.read_text()) for path in root.glob("*.schema.json")}
registry = Registry().with_resources(
    ((root / name).as_uri(), Resource.from_contents(schema))
    for name, schema in schemas.items()
)
validators = {}
for name, schema in schemas.items():
    Draft202012Validator.check_schema(schema)
    validators[name.removesuffix(".schema.json")] = Draft202012Validator(
        {"$ref": (root / name).as_uri()}, registry=registry, format_checker=FormatChecker()
    )

candidate = json.loads((root / "claim-candidate.example.json").read_text())
subject = candidate["subject"]
gap = {**subject, "finding": "documented_gap"}
quantity = {"type": "quantity", "value": "0.003", "unit": "m"}
value = {"kind": "value", "parameterId": "demo.thickness", "observedValue": quantity}
receipt = {
    "schemaVersion": 1, "workId": "work-A", "inputRevision": "rev-A",
    "outcome": "complete", "candidates": [candidate], "diagnostics": [],
}
review = {
    "schemaVersion": 1, "workId": "work-review", "candidateRevision": "claim-A-r1",
    "verdict": "supported", "reason": "Строка сверена.", "checkedPlaces": candidate["evidence"],
}

intent = {
    "schemaVersion": 1, "intentId": "intent-A", "workId": "extract-1",
    "inputRevision": "source-set-1", "policyRevision": "policy-1",
    "obligationId": "check-width", "scopeTarget": {"kind": "unresolved"},
    "trigger": {"kind": "unit", "id": "page-2"},
    "target": {"unitIds": ["page-2"], "methodProfileId": "visual-table"},
    "reason": "Заголовок и строки таблицы присутствуют только на изображении.",
    "disposition": {"status": "accepted", "reasonCode": "eligible", "workId": "visual-2"},
}

survey = {
    "schemaVersion": 1, "workId": "blind-2", "turnId": "turn-1", "mode": "coverage_check",
    "documentRevisionId": "pdf-r1", "pageNumber": 2, "sheetRenderId": "render-2",
    "inspectedLocatorIds": ["page-2-full"], "regions": [], "limitations": [],
}

independent = {
    **survey, "schemaVersion": 2, "mode": "independent_read", "branchId": "A",
    "inputSnapshotId": "project-rev-3", "modelRevisionId": "model-A-resolved-rev",
    "readingProfileRevisionId": "pdf-quality-1",
}
missing = {
    "kind": "confirmed_missing", "obligationId": "nodes-A", "issueRevisionId": "missing-A-v2",
    "evidenceIds": ["register-row-A"], "absenceBasis": "explicit_non_delivery",
    "inventoryAssessmentId": "all-relevant-inputs-r3",
}
conflict = {
    "kind": "confirmed_conflict", "obligationId": "thickness-A", "issueRevisionId": "conflict-A-v2",
    "evidenceIds": ["spec-A-row-1", "assignment-A-row-4"],
}
selection = {
    "schemaVersion": 1, "assessmentRevisionId": "assessment-3", "engineerDecisionId": "decision-2",
    "scopeId": "facade-A", "recipientId": "designer", "items": [missing, conflict],
}

receipt_scope = {
    "schemaVersion": 1, "inventoryAssessmentId": "inventory-A", "obligationId": "editable-plan",
    "snapshotId": "snapshot-A", "scope": "receipt", "receiptIds": ["package-1"],
    "asOf": "2026-01-15T12:00:00Z", "result": "bounded", "unresolvedDependencies": [],
}

image_part = {
    "kind": "inline_image", "sha256": "a" * 64, "parentRenderSha256": "b" * 64,
    "transformId": "render-to-crop", "mimeType": "image/png", "widthPx": 208, "heightPx": 72,
}
file_part = {**image_part, "kind": "provider_file", "providerFileId": "file-A"}
model_input = {
    "schemaVersion": 1, "attemptId": "attempt-2", "workId": "work-1", "turnId": "turn-2",
    "branchId": "B", "inputSnapshotId": "snapshot-1", "modelRevisionId": "model-B",
    "documentRevisionId": "doc-1", "viewRevisionId": "page-2", "locatorId": "crop-2",
    "origin": {"kind": "tool_result", "toolCallId": "call-1"}, "contentPartIndex": 1, "part": image_part,
}
groups = [
    ("model-input-receipt", model_input, [
        ({}, True),
        ({"part": {**file_part, "uploadReceiptId": "upload-A"}}, True),
        ({"part": file_part}, False),
        ({"part": {**image_part, "providerFileId": "unexpected"}}, False),
        ({"part": {"kind": "text_only", "reason": "native_text", "sha256": "d" * 64}}, True),
        ({"part": {**image_part, "kind": "text_only", "reason": "missing_pixels"}}, False),
        ({"part": {**image_part, "sha256": "artifact-id"}}, False),
        ({"part": {**image_part, "widthPx": 0}}, False),
        ({"origin": {"kind": "initial_overview"}}, True),
        ({"origin": {"kind": "tool_result"}}, False),
        ({"contentPartIndex": -1}, False),
        ({"locatorId": ""}, False),
    ]),
    ("inventory-scope", receipt_scope, [
        ({}, True),
        ({"scope": "project_as_of"}, False),
        ({"scope": "project_as_of", "projectBoundaryEvidenceId": "approved-register-v2"}, True),
        ({"scope": "project_as_of", "result": "open", "unresolvedDependencies": ["later-delivery"]}, True),
        ({"unresolvedDependencies": ["unread-linked-fragment"]}, False),
        ({"result": "open"}, False),
        ({"receiptIds": ["package-1", "package-2"]}, False),
        ({"asOf": "до досылки, точной даты нет"}, False),
        ({"projectBoundaryEvidenceId": "register-v2"}, False),
        ({"scope": "project_as_of", "projectBoundaryEvidenceId": "register-v2", "unresolvedDependencies": ["later-delivery"]}, False),
    ]),
    ("page-survey.v2", independent, [
        ({}, True),
        ({"branchId": "B", "modelRevisionId": "model-B-resolved-rev"}, True),
        ({"modelRevisionId": ""}, False),
        ({"inputSnapshotId": ""}, False),
        ({"branchId": "both"}, False),
        ({"mode": "verify_candidates"}, False),
        ({"readingProfileRevisionId": ""}, False),
    ]),
    ("letter-selection", selection, [
        ({}, True),
        ({"items": [conflict]}, True),
        ({"items": [{**missing, "absenceBasis": "exhaustive_inventory"}]}, True),
        ({"items": []}, False),
        ({"engineerDecisionId": ""}, False),
        ({"items": [{**missing, "kind": "unreadable"}]}, False),
        ({"items": [{**missing, "absenceBasis": "model_consensus"}]}, False),
        ({"items": [{k: v for k, v in missing.items() if k != "inventoryAssessmentId"}]}, False),
        ({"items": [{**conflict, "evidenceIds": ["place-1"]}]}, False),
        ({"items": [{**conflict, "evidenceIds": ["place-1", "place-1"]}]}, False),
        ({"items": [{**missing, "kind": "manual_question"}]}, False),
    ]),
    ("page-survey", survey, [
        ({}, True),
        ({"mode": "sheet_overview"}, True),
        ({"regions": [{"locatorId": "p2-lower-right", "description": "Таблица в поле чертежа"}]}, True),
        ({"limitations": ["Мелкий шрифт требует увеличения."]}, True),
        ({"pageNumber": 0}, False),
        ({"sheetRenderId": ""}, False),
        ({"inspectedLocatorIds": []}, False),
        ({"regions": [{"description": "Таблица без места"}]}, False),
        ({"complete": True}, False),
        ({"verdict": "supported"}, False),
    ]),
    ("research-intent", intent, [
        ({}, True),
        ({"scopeTarget": {"kind": "accepted", "scopeId": "facade-A"}}, True),
        ({"scopeTarget": {"kind": "accepted"}}, False),
        ({"scopeTarget": {"kind": "unresolved", "scopeId": "A"}}, False),
        ({"target": {"unitIds": [], "methodProfileId": "visual-table"}}, False),
        ({"disposition": {"status": "reused", "reasonCode": "same_work", "workId": "visual-2"}}, True),
        ({"disposition": {"status": "accepted", "reasonCode": "eligible"}}, False),
        ({"disposition": {"status": "deferred", "reasonCode": "budget", "resumeCondition": "new_approval"}}, True),
        ({"disposition": {"status": "deferred", "reasonCode": "budget"}}, False),
        ({"disposition": {"status": "rejected", "reasonCode": "scope_denied"}}, True),
        ({"disposition": {"status": "rejected", "reasonCode": "scope_denied", "workId": "other"}}, False),
    ]),
    ("claim-candidate", candidate, [
        ({}, True),
        ({"evidence": []}, False),
        ({"evidence": candidate["evidence"] * 2}, False),
        ({"confirmedByEngineer": True}, False),
        ({"subject": gap}, False),
        ({"subject": {**gap, "gapBasis": "explicit_non_delivery"}}, True),
        ({"subject": {**gap, "gapBasis": "exhaustive_inventory"}}, True),
        ({"subject": {**gap, "gapBasis": "exhausted"}}, False),
        ({"subject": {**subject, "gapBasis": "explicit_non_delivery"}}, False),
        ({"subject": value}, True),
        ({"subject": {**value, "observedValue": {"type": "quantity", "value": "2"}}}, False),
        ({"subject": {**value, "observedValue": {"type": "boolean", "value": "true"}}}, False),
    ]),
    ("research-result", receipt, [
        ({}, True),
        ({"outcome": "partial", "diagnostics": ["одна строка отклонена"]}, True),
        ({"outcome": "partial"}, False),
        ({"outcome": "held", "diagnostics": ["unknown"]}, False),
        ({"outcome": "held", "candidates": [], "diagnostics": ["unknown"]}, True),
        ({"outcome": "unusable", "candidates": [], "diagnostics": ["обрыв JSON"]}, True),
        ({"outcome": "exhausted", "candidates": [], "diagnostics": ["лимит"]}, True),
        ({"outcome": "no_match", "candidates": []}, True),
        ({"outcome": "no_match"}, False),
        ({"candidates": []}, False),
        ({"candidates": [{**candidate, "subject": gap}]}, False),
    ]),
    ("review-result", review, [
        ({}, True),
        ({"checkedPlaces": []}, False),
        ({"verdict": "needs_evidence", "checkedPlaces": []}, True),
        ({"verdict": "rejected", "checkedPlaces": []}, True),
        ({"verdict": "confirmedByEngineer"}, False),
        ({"candidateRevision": ""}, False),
    ]),
]
for name, base, cases in groups:
    schema_key = name if "." in name else f"{name}.v1"
    for patch, expected in cases:
        if validators[schema_key].is_valid({**base, **patch}) != expected:
            raise ValueError(f"Ошибка ожидания для {name}: {patch}")
    print(f"{name}: {len(cases)} OK")

import { invalidInput } from "./store.js";

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) {
    invalidInput("Требуется UUID.");
  }
  return value.toLowerCase();
}

export function versionNumber(value: unknown): number {
  const version = typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : value;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
    invalidInput("Требуется целый номер версии.");
  }
  return version;
}

function fields(value: unknown, valid: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidInput("Ожидается объект JSON.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !valid.includes(key))) invalidInput("Передано неизвестное поле.");
  return input;
}

export function shortText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || !value.isWellFormed() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    invalidInput("Требуется непустое текстовое поле допустимой длины.");
  }
  return value.trim();
}

function choice<T extends string>(value: unknown, options: readonly T[]): T {
  const found = options.find((option) => option === value);
  if (!found) invalidInput("Передано недопустимое действие или состояние.");
  return found;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalidInput("Ожидается логическое значение.");
  return value;
}

function exclusionDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const pattern = /^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const day = typeof value === "string" ? pattern.exec(value)?.[1] : undefined;
  if (typeof value !== "string" || !day) invalidInput("Срок исключения указывается с часовым поясом.");
  const date = new Date(value);
  const utcDay = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || !Number.isFinite(utcDay.valueOf()) ||
      utcDay.toISOString().slice(0, 10) !== day || day.startsWith("0000")) {
    invalidInput("Недопустимый срок исключения.");
  }
  return date.toISOString();
}

export function parseDecision(value: unknown) {
  const input = fields(value, ["action", "reason", "requestExternal", "outcome", "observationIds", "exclusion",
    "startWorkCritical"]);
  const action = choice(input.action, ["confirm", "correct", "exclude", "revoke", "request_clarification"] as const);
  const base = {
    action,
    reason: shortText(input.reason, 2000),
    requestExternal: optionalBoolean(input.requestExternal),
    startWorkCritical: optionalBoolean(input.startWorkCritical),
  };
  if (action === "correct") {
    if ("exclusion" in input) invalidInput("Для исключения нужна отдельная команда.");
    if (input.observationIds !== undefined &&
        (!Array.isArray(input.observationIds) || input.observationIds.length > 100)) {
      invalidInput("Передайте не более 100 ID наблюдений.");
    }
    return {
      ...base,
      outcome: choice(input.outcome, ["covered", "confirmed_missing", "confirmed_conflict", "needs_review"] as const),
      observationIds: (input.observationIds as unknown[] | undefined)?.map(identifier),
    };
  }
  if ("observationIds" in input || "outcome" in input) invalidInput("Эти поля допустимы для исправления.");
  if (action === "exclude") {
    const exclusion = fields(input.exclusion, ["kind", "until"]);
    return {
      ...base,
      exclusion: {
        kind: choice(exclusion.kind, ["not_required", "work_without_data"] as const),
        until: exclusionDate(exclusion.until),
      },
    };
  }
  if ("exclusion" in input) invalidInput("Для исключения нужна отдельная команда.");
  return base;
}

function parseConclusionBasis(value: unknown) {
  const basis = fields(value, ["kind", "versionId", "anchor", "evidenceId", "occurrenceId", "inventoryRevision"]);
  if (basis.kind === "original") return { kind: "original" as const, versionId: identifier(basis.versionId), anchor: shortText(basis.anchor, 200) };
  if (basis.kind === "citation") return { kind: "citation" as const, evidenceId: identifier(basis.evidenceId) };
  if (basis.kind === "inventory") return { kind: "inventory" as const, occurrenceId: identifier(basis.occurrenceId), inventoryRevision: shortText(basis.inventoryRevision, 100) };
  return invalidInput("Выберите исходное место или ограничение описи.");
}

export function parseConclusion(value: unknown) {
  const input = fields(value, ["scopeId", "assessmentContextId", "startWork", "reason", "basis"]);
  if ((input.scopeId === undefined) === (input.assessmentContextId === undefined)) {
    invalidInput("Укажите область или контекст оценки.");
  }
  return {
    scopeId: input.scopeId === undefined ? undefined : identifier(input.scopeId),
    assessmentContextId: input.assessmentContextId === undefined ? undefined : identifier(input.assessmentContextId),
    ...(input.basis !== undefined ? { basis: parseConclusionBasis(input.basis) } : {}),
    startWork: choice(input.startWork, ["can_start", "cannot_start", "can_start_with_limitations"] as const),
    reason: shortText(input.reason, 2000),
  };
}

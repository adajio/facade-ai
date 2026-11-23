import type { SourceAddress } from './copilot';
import { type Assessment, type Citation } from './workspace';

export const observationLabels = {
  identified: 'Привязано к фасадам',
  common: 'Общие сведения',
  unclear: 'Неясные привязки',
  unidentified: 'Фасад не установлен',
} as const;
export type Binding = keyof typeof observationLabels;
export type FacadeObservation = Pick<Citation, 'branch' | 'versionId' | 'documentId' | 'sha256' | 'address'> & {
  id: string;
  attribute: string | null;
  quote: string | null;
  value: string | null;
  unit: string | null;
  evidenceHref: string;
  evidenceId?: string;
  proposedFacadeKind?: string | null;
  facadeKindSourceVerified?: boolean;
  revision?: string | null;
  revisionStatus?: string;
  binding: { state: Binding; reason: string; candidates: { id: string; label: string }[] };
};

export type FacadeType = {
  state: 'confirmed' | 'unconfirmed' | 'stale'; kind: string | null;
  basis: { id: string; evidenceId: string; versionId: string; address: SourceAddress; quote?: string | null; revision: string } | null;
};

export type Boundary = { complete: boolean; reason: string | null; basisIds: string[] };
export type FacadeContext = Omit<Assessment, 'scope' | 'catalogVersionId'> & {
  assessmentContextId: string;
  kind: 'facade' | 'common';
  facadeId: string | null;
  name: string;
  counts: Record<string, number>;
  facadeType?: FacadeType;
  questionHolds: { questionId: string; receiptIds: string[] }[];
};
export type FacadeAssessment = {
  projectId: string;
  version: number;
  catalogVersionId: string | null;
  stage: string | null;
  activeWindows: number;
  completedWindows: number;
  structurallyReviewedWindows?: number;
  observations: { counts: Record<Binding, number>; href: string };
  coverage: Record<'inventory' | 'map' | 'reading' | 'subject', Boundary>;
  contexts: FacadeContext[];
  limitations: string[];
  outcome: string;
};

export const coverageLabels = {
  inventory: 'Опись',
  map: 'Физическая карта',
  reading: 'Проверка A/B',
  subject: 'Граница фасадов',
} as const;

export const assessmentReasons: Record<string, string> = {
  catalog_unassigned: 'Нет рабочего каталога',
  catalog_not_applicable: 'Назначенный каталог не применим к текущей стадии и типам фасадов',
  catalog_empty: 'В каталоге нет требований',
  catalog_scope_undeclared: 'Для строк каталога требуется область применимости',
  catalog_evidence_rule_unset: 'В каталоге не задано правило проверки доказательств по требованию',
  stage_unknown: 'Стадия не установлена',
  inventory_open: 'Опись ещё не зафиксирована',
  inventory_items_excluded: 'Из описи исключены отдельные позиции',
  inventory_import_incomplete: 'Не все операции импорта завершились успешно',
  material_not_mapped: 'Карта материала ещё не подготовлена',
  reading_pending: 'Ожидается чтение',
  structural_remainder_open: 'Остались непрочитанные блоки',
  semantic_check_missing: 'Содержание ещё не проверено по этому требованию',
  semantic_independence_unproven: 'Независимость проверок не подтверждена',
  semantic_remainder_open: 'Есть непроверенные области по требованиям',
  facade_profile_basis_stale: 'Требуется заново подтвердить типы фасадов для выбранного профиля',
  physical_map_unverified: 'Полнота физической карты не подтверждена',
  reading_incomplete: 'Применимый охват A/B ещё не подтверждён',
  facade_boundary_unverified: 'Полный перечень фасадов и общий уровень не подтверждены',
  supplement_membership_unknown: 'Необходим разбор применимости досылки',
  supplement_review_required: 'Необходим пересмотр с учётом досылки',
  no_applicable_requirements: 'Применимых требований пока нет',
  requirement_not_proven: 'Доказательства по требованию неполны',
  required_evidence_incomplete: 'Комплект обязательных доказательств по требованию неполон',
  alternatives_unverified: 'Проверка возможных альтернатив не завершена',
  pair_verification_required: 'Для подтверждения противоречия нужна сверка пары опор',
};

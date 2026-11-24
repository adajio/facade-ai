import type { OriginalBasis } from './facade-assessment';

export type Actor = {
  id: string;
  organizationId: string;
  login: string;
  displayName?: string;
  name?: string;
};

export type Catalog = {
  id: string;
  name: string;
  revision: number;
  key?: string;
  requirements?: unknown;
  description?: string;
};

export type Scope = {
  id: string;
  name: string;
  stage: string;
  version: number;
  requirements?: unknown;
};

export type Project = {
  id: string;
  name: string;
  version: number;
  role?: string;
  scopeId?: string | null;
  actions?: string[];
  scopes: Scope[];
  catalog?: Catalog | null;
  catalogVersionId?: string | null;
  catalogState?: 'unassigned' | 'legacy_empty' | 'assigned';
  intakeMode?: boolean;
  stage?: string | null;
  stageStatus?: 'unknown' | 'legacy_unconfirmed' | 'confirmed';
  stageBasis?: OriginalBasis | { provenanceKind: 'machine_verified'; evidenceIds: string[] } | null;
  confirmedFacadeKinds?: string[];
  updatedAt?: string;
};

export type Session = {
  user: Actor;
  csrfToken: string;
  actions?: string[];
  projects: Project[];
  nextCursor?: string | null;
};

export type ProjectRead = Project | { project: Project; actions?: string[]; scopes?: Scope[]; role?: string; catalog?: Catalog | null };

export function projectOf(body: ProjectRead): Project {
  if ('project' in body) {
    return {
      ...body.project,
      actions: body.actions ?? body.project.actions,
      role: body.role ?? body.project.role,
      scopes: body.scopes ?? body.project.scopes ?? [],
      catalog: body.catalog === undefined ? body.project.catalog : body.catalog,
    };
  }
  return { ...body, scopes: body.scopes ?? [] };
}

export function available(project: Project, action: string) {
  return project.actions?.includes(action) ?? false;
}

export function collection<T, K extends string>(result: T[] | { [P in K]: T[] }, key: K): T[] {
  return Array.isArray(result) ? result : result[key] ?? [];
}

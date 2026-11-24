import type { PoolClient } from "pg";
import { AccessError } from "../access/errors.js";
import { requirementSubjectKey } from "./domain.js";
import type { FacadeObservation } from "./facade-input.js";
import type { OriginalBasis } from "../intake/accepted-originals.js";

type TypeBasis = Pick<FacadeObservation, "id" | "evidenceId" | "evidenceHref" | "versionId" | "address" | "quote"> & {
  bindingVersion: number;
  revision: string;
  provenanceKind?: "machine_verified";
};

type Assignment = { contextId: string; version: number; kind: string; basis: TypeBasis | OriginalBasis };

export type FacadeType = { state: "unconfirmed"; kind: null; basis: null; version: null } |
  { state: "confirmed" | "stale"; kind: string; basis: TypeBasis | OriginalBasis; version: number };

function verifiedTypeSource(fact: FacadeObservation | undefined, facadeId: string, kind: string, stage: string | null) {
  return fact && fact.proposedFacadeKind && fact.facadeKindSourceVerified && fact.revisionStatus === "current" && fact.revision &&
    fact.binding.state === "identified" && fact.binding.candidates.length === 1 && fact.binding.candidates[0].id === facadeId &&
    requirementSubjectKey(kind) === requirementSubjectKey(fact.proposedFacadeKind) &&
    (!stage || !fact.designStage || requirementSubjectKey(stage) === requirementSubjectKey(fact.designStage));
}

export function conflictingFacadeTypes(facts: FacadeObservation[], facadeId: string, stage: string | null) {
  const sources = new Map(facts.flatMap((fact) => {
    const kind = fact.proposedFacadeKind;
    return kind && verifiedTypeSource(fact, facadeId, kind, stage) ? [[requirementSubjectKey(kind), fact] as const] : [];
  }));
  return sources.size > 1 ? [...sources.values()] : [];
}

export function facadeTypeView(assignment: Assignment | undefined, fact: FacadeObservation | undefined, facadeId: string,
  stage: string | null, conflicted = false, currentOriginal?: boolean): FacadeType {
  if (!assignment) return { state: "unconfirmed", kind: null, basis: null, version: null };
  const { basis, kind, version } = assignment;
  if (basis.provenanceKind === "engineer_override") {
    return { state: currentOriginal ? "confirmed" : "stale", kind, basis, version };
  }
  const current = !conflicted && fact && verifiedTypeSource(fact, facadeId, kind, stage) && fact.id === basis.id &&
    fact.evidenceId === basis.evidenceId && fact.versionId === basis.versionId &&
    fact.binding.version === basis.bindingVersion && fact.revision === basis.revision;
  return { state: current ? "confirmed" : "stale", kind, basis, version };
}

export async function readFacadeTypes(tx: PoolClient, projectId: string) {
  const { rows } = await tx.query<Assignment>(
    `SELECT DISTINCT ON (context_id) context_id AS "contextId", version, kind, basis
       FROM facade_type_assignments WHERE project_id=$1 ORDER BY context_id,version DESC`, [projectId],
  );
  return new Map(rows.map((row) => [row.contextId, row]));
}

export async function recordFacadeType(tx: PoolClient, input: {
  projectId: string; contextId: string; facadeId: string; stage: string | null; kind: string;
  fact?: FacadeObservation; original?: OriginalBasis; reason: string; actorId: string;
}) {
  const { projectId, contextId, facadeId, stage, kind, fact, original, reason, actorId } = input;
  let basis: TypeBasis | OriginalBasis;
  if (original) {
    basis = original;
  } else {
    if (!fact || !verifiedTypeSource(fact, facadeId, kind, stage)) {
      throw new AccessError(422, "facade_type_basis_invalid", "Укажите действующую адресную опору типа именно этого фасада.");
    }
    const { id, evidenceId, evidenceHref, versionId, address, quote, binding, revision } = fact;
    basis = { id, evidenceId, evidenceHref, versionId, address, quote, bindingVersion: binding.version, revision: revision!,
      provenanceKind: "machine_verified" };
  }
  const machine = basis.provenanceKind === "engineer_override" ? undefined : basis;
  await tx.query(
    `INSERT INTO facade_type_assignments(project_id,context_id,version,kind,observation_id,evidence_id,
       original_version_id,binding_version,basis,author_id,reason)
     SELECT $1,$2,coalesce(max(version),0)+1,$3,$4,$5,$6,$7,$8,$9,$10
     FROM facade_type_assignments WHERE context_id=$2`,
    [projectId, contextId, kind, machine?.id, machine?.evidenceId, basis.versionId, machine?.bindingVersion, basis, actorId, reason],
  );
}

ALTER TABLE projects ADD COLUMN project_stage_basis jsonb;

ALTER TABLE facade_type_assignments
    ALTER COLUMN observation_id DROP NOT NULL,
    ALTER COLUMN evidence_id DROP NOT NULL,
    ALTER COLUMN binding_version DROP NOT NULL,
    ADD CONSTRAINT facade_type_assignment_basis CHECK (
        num_nonnulls(observation_id, evidence_id, binding_version) = 3 OR
        (num_nonnulls(observation_id, evidence_id, binding_version) = 0 AND
         (basis->>'provenanceKind' = 'engineer_override') IS TRUE)
    );

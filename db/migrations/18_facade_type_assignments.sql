ALTER TABLE projects ADD COLUMN facade_kinds_from_assignments boolean NOT NULL DEFAULT false;

CREATE TABLE facade_type_assignments (
    project_id uuid NOT NULL,
    context_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
    observation_id uuid NOT NULL REFERENCES reader_observations(id),
    evidence_id uuid NOT NULL REFERENCES reader_evidence(id),
    original_version_id uuid NOT NULL,
    binding_version integer NOT NULL CHECK (binding_version > 0),
    basis jsonb NOT NULL,
    author_id uuid NOT NULL REFERENCES users(id),
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (context_id, version),
    FOREIGN KEY (project_id, context_id) REFERENCES facade_assessment_contexts(project_id,id),
    FOREIGN KEY (project_id, original_version_id) REFERENCES intake_document_versions(project_id,id)
);

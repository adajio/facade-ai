ALTER TABLE catalog_versions
  ADD COLUMN default_stage text,
  ADD COLUMN default_facade_kinds text[],
  ADD COLUMN approval_reference text,
  ADD CONSTRAINT catalog_default_profile_complete CHECK (
    (default_stage IS NULL AND default_facade_kinds IS NULL AND approval_reference IS NULL)
    OR (default_stage IS NOT NULL AND default_facade_kinds IS NOT NULL AND approval_reference IS NOT NULL
        AND cardinality(default_facade_kinds) > 0)
  );

CREATE INDEX catalog_default_profiles ON catalog_versions (organization_id, default_stage)
  WHERE default_stage IS NOT NULL;

ALTER TABLE projects
  ALTER COLUMN catalog_version_id DROP NOT NULL,
  ADD COLUMN intake_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN project_stage text,
  ADD COLUMN confirmed_facade_kinds text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT projects_legacy_catalog_required CHECK (intake_mode OR catalog_version_id IS NOT NULL);

CREATE INDEX projects_awaiting_catalog ON projects (organization_id, project_stage)
  WHERE intake_mode AND catalog_version_id IS NULL;

CREATE TABLE document_stage_confirmations (
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  target jsonb NOT NULL,
  stage text NOT NULL,
  reason text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES reader_evidence(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL CHECK (version > 1),
  PRIMARY KEY (project_id, version_id, target),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id)
);

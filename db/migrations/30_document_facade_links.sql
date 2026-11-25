ALTER TABLE facade_assessment_contexts ADD COLUMN manual_name text
  CHECK (manual_name IS NULL OR (kind = 'facade' AND length(manual_name) BETWEEN 1 AND 160));

CREATE TABLE document_facade_links (
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 1),
  target_key text NOT NULL,
  context_id uuid NOT NULL,
  facade_label text NOT NULL,
  original_basis jsonb NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, version_id, version),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id),
  FOREIGN KEY (project_id, context_id) REFERENCES facade_assessment_contexts(project_id, id)
);

CREATE INDEX document_facade_links_by_target ON document_facade_links (project_id, version_id, target_key, version DESC);

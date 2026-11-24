CREATE TABLE fragment_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  document_id uuid NOT NULL,
  original_version_id uuid NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  reader_version text NOT NULL,
  page integer NOT NULL CHECK (page > 0),
  box jsonb NOT NULL CHECK (jsonb_typeof(box) = 'object'),
  quote text CHECK (length(quote) BETWEEN 1 AND 500),
  image bytea CHECK (octet_length(image) BETWEEN 24 AND 4194304),
  CHECK (num_nonnulls(quote, image) = 1),
  FOREIGN KEY (project_id, scope_id) REFERENCES project_scopes(project_id, id),
  FOREIGN KEY (project_id, original_version_id) REFERENCES intake_document_versions(project_id, id),
  FOREIGN KEY (document_id, original_version_id) REFERENCES intake_document_versions(document_id, id)
);
CREATE INDEX fragment_publications_scope ON fragment_publications(project_id, scope_id, id);

-- Content and scope are immutable. A new selection or audience starts a new publication.
CREATE TABLE fragment_publication_revisions (
  publication_id uuid NOT NULL REFERENCES fragment_publications(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 3),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (publication_id, version)
);

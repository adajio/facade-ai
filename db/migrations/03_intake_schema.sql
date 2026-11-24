CREATE TABLE intake_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY,
  project_id uuid NOT NULL REFERENCES projects(id),
  source text NOT NULL CHECK (source IN ('upload', 'import')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  UNIQUE (project_id, id)
);
CREATE INDEX intake_receipts_project_number ON intake_receipts (project_id, number DESC);

CREATE TABLE intake_project_generations (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  generation bigint NOT NULL DEFAULT 0,
  unknown_generation bigint NOT NULL DEFAULT 0
);
CREATE TABLE intake_scope_generations (
  project_id uuid NOT NULL REFERENCES projects(id),
  scope_id uuid PRIMARY KEY,
  generation bigint NOT NULL,
  FOREIGN KEY (project_id, scope_id) REFERENCES project_scopes(project_id, id)
);
CREATE TABLE intake_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('upload', 'import')),
  source_id uuid NOT NULL,
  generation bigint NOT NULL,
  version integer NOT NULL DEFAULT 1,
  scope_ids uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id),
  UNIQUE (source, source_id),
  CHECK (scope_ids IS NULL OR cardinality(scope_ids) > 0)
);
CREATE INDEX intake_holds_active ON intake_holds (project_id) WHERE closed_at IS NULL;

CREATE TABLE intake_imports (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  hold_id uuid NOT NULL UNIQUE REFERENCES intake_holds(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'paused', 'completed', 'limited', 'failed', 'cancelled')),
  reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id),
  UNIQUE (receipt_id, id)
);

CREATE TABLE intake_originals (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  object_key text NOT NULL UNIQUE,
  size bigint NOT NULL CHECK (size >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, sha256, size)
);
CREATE TABLE intake_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);
CREATE TABLE intake_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  original_id uuid NOT NULL,
  media_type text NOT NULL,
  replaces_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, document_id) REFERENCES intake_documents(project_id, id),
  FOREIGN KEY (project_id, original_id) REFERENCES intake_originals(project_id, id),
  UNIQUE (project_id, id),
  UNIQUE (document_id, id),
  FOREIGN KEY (document_id, replaces_version_id) REFERENCES intake_document_versions(document_id, id)
);
CREATE TABLE intake_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  parent_occurrence_id uuid,
  import_id uuid,
  relative_path text NOT NULL,
  declared_media_type text NOT NULL,
  version_id uuid,
  inventory_pending boolean NOT NULL DEFAULT false,
  restriction text,
  state text NOT NULL DEFAULT 'declared' CHECK (state IN ('declared', 'accepted', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id),
  UNIQUE (receipt_id, id),
  FOREIGN KEY (receipt_id, parent_occurrence_id) REFERENCES intake_occurrences(receipt_id, id),
  FOREIGN KEY (receipt_id, import_id) REFERENCES intake_imports(receipt_id, id),
  CHECK ((state = 'accepted') = (version_id IS NOT NULL))
);
CREATE INDEX intake_occurrences_receipt ON intake_occurrences (receipt_id, created_at, id);

CREATE TABLE intake_uploads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  occurrence_id uuid NOT NULL UNIQUE,
  hold_id uuid REFERENCES intake_holds(id),
  replaces_version_id uuid,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'complete', 'cancelled', 'expired')),
  size bigint NOT NULL CHECK (size >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  part_size integer NOT NULL CHECK (part_size > 0),
  declaration_hash text NOT NULL,
  cleaned_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id),
  FOREIGN KEY (receipt_id, occurrence_id) REFERENCES intake_occurrences(receipt_id, id),
  FOREIGN KEY (project_id, replaces_version_id) REFERENCES intake_document_versions(project_id, id)
);
CREATE INDEX intake_uploads_receipt ON intake_uploads (receipt_id);
CREATE INDEX intake_uploads_expiry ON intake_uploads (expires_at) WHERE state = 'uploading';

CREATE TABLE intake_parts (
  upload_id uuid NOT NULL REFERENCES intake_uploads(id),
  number integer NOT NULL CHECK (number > 0),
  byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
  length integer NOT NULL CHECK (length > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (upload_id, number)
);

CREATE TABLE intake_reader_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_id uuid NOT NULL UNIQUE,
  original_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id),
  FOREIGN KEY (project_id, document_id) REFERENCES intake_documents(project_id, id),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id),
  FOREIGN KEY (project_id, original_id) REFERENCES intake_originals(project_id, id)
);
CREATE INDEX intake_reader_jobs_pending ON intake_reader_jobs (created_at, id) WHERE dispatched_at IS NULL;

CREATE TABLE intake_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id)
);
CREATE INDEX intake_events_project ON intake_events (project_id, id);

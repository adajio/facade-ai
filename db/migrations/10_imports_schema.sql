CREATE TABLE import_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id),
  source_url text,
  occurrence_id uuid,
  version_id uuid,
  root_occurrence_id uuid,
  depth integer CHECK (depth >= 1),
  relative_path text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'completed', 'limited', 'failed', 'cancelled')),
  reason text,
  available_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  expanded_bytes bigint NOT NULL DEFAULT 0 CHECK (expanded_bytes >= 0),
  manifest_saved boolean NOT NULL DEFAULT false,
  UNIQUE (occurrence_id),
  UNIQUE (receipt_id, id),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id),
  FOREIGN KEY (receipt_id, occurrence_id) REFERENCES intake_occurrences(receipt_id, id),
  FOREIGN KEY (receipt_id, root_occurrence_id) REFERENCES intake_occurrences(receipt_id, id),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id),
  CHECK (
    (source_url IS NOT NULL AND actor_id IS NOT NULL AND occurrence_id IS NULL
      AND version_id IS NULL AND root_occurrence_id IS NULL AND depth IS NULL AND relative_path IS NULL)
    OR
    (source_url IS NULL AND occurrence_id IS NOT NULL
      AND version_id IS NOT NULL AND root_occurrence_id IS NOT NULL AND depth IS NOT NULL AND relative_path IS NOT NULL)
  )
);
CREATE INDEX import_jobs_schedule ON import_jobs ((source_url IS NOT NULL), available_at, created_at, id)
  WHERE status IN ('queued', 'running', 'paused');
CREATE INDEX import_jobs_root ON import_jobs (root_occurrence_id);
CREATE INDEX import_jobs_receipt ON import_jobs (receipt_id, created_at, id);

CREATE TABLE import_inventory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES import_jobs(id),
  receipt_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  parent_id uuid,
  original_path text NOT NULL,
  relative_path text,
  remote_path text,
  kind text NOT NULL CHECK (kind IN ('directory', 'file', 'special')),
  observed_bytes bigint NOT NULL DEFAULT 0 CHECK (observed_bytes >= 0),
  expected_bytes bigint CHECK (expected_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text,
  state text NOT NULL CHECK (state IN ('discovered', 'directory', 'accepted', 'rejected')),
  reason text,
  upload_id uuid REFERENCES intake_uploads(id),
  occurrence_id uuid,
  version_id uuid REFERENCES intake_document_versions(id),
  UNIQUE (job_id, ordinal),
  UNIQUE (job_id, id),
  FOREIGN KEY (receipt_id, job_id) REFERENCES import_jobs(receipt_id, id),
  FOREIGN KEY (job_id, parent_id) REFERENCES import_inventory_entries(job_id, id),
  FOREIGN KEY (receipt_id, occurrence_id) REFERENCES intake_occurrences(receipt_id, id)
);
CREATE INDEX import_inventory_receipt ON import_inventory_entries (receipt_id, id);

CREATE TABLE import_scratch_reservations (
  job_id uuid NOT NULL REFERENCES import_jobs(id),
  slot text NOT NULL CHECK (slot IN ('source', 'entry')),
  pending_bytes bigint NOT NULL CHECK (pending_bytes >= 0),
  PRIMARY KEY (job_id, slot)
);

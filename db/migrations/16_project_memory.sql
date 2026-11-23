CREATE TABLE project_memory_versions (
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  contract integer NOT NULL CHECK (contract > 0),
  reader_version text,
  format text,
  total integer CHECK (total >= 0),
  next_ordinal integer NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
  physical_limitation text,
  retry_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, contract),
  UNIQUE (project_id, version_id, contract),
  CHECK (next_ordinal <= total),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id),
  FOREIGN KEY (project_id, version_id, reader_version) REFERENCES reader_maps(project_id, version_id, reader_version)
);

CREATE TABLE project_memory_blocks (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  contract integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  unit_id text NOT NULL,
  address jsonb NOT NULL CHECK (jsonb_typeof(address) = 'object'),
  artifact_sha256 text CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_size integer CHECK (artifact_size > 0),
  limitations text[] NOT NULL,
  remaining text[] NOT NULL CHECK (remaining <@ ARRAY['native','graphics','ocr']::text[]),
  CHECK ((artifact_sha256 IS NULL) = (artifact_size IS NULL)),
  UNIQUE (version_id, contract, ordinal),
  UNIQUE (version_id, contract, unit_id),
  FOREIGN KEY (project_id, version_id, contract) REFERENCES project_memory_versions(project_id, version_id, contract)
);

CREATE TABLE project_memory_lines (
  block_id text NOT NULL REFERENCES project_memory_blocks(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  line_id text NOT NULL,
  literal text NOT NULL,
  folded text NOT NULL,
  address jsonb NOT NULL CHECK (jsonb_typeof(address) = 'object'),
  PRIMARY KEY (block_id, ordinal)
);

-- This is an immutable, scoped manifest of the visible version/cursor state. Block data stays in the index.
CREATE TABLE project_memory_snapshots (
  project_id uuid NOT NULL REFERENCES projects(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);

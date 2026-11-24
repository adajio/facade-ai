CREATE TABLE reader_maps (
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_id uuid NOT NULL,
  reader_version text NOT NULL,
  receipt_id uuid NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  format text NOT NULL,
  units jsonb NOT NULL CHECK (jsonb_typeof(units) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, reader_version),
  UNIQUE (project_id, version_id, reader_version),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id),
  FOREIGN KEY (document_id, version_id) REFERENCES intake_document_versions(document_id, id),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id)
);

CREATE TABLE reader_evidence (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  reader_version text NOT NULL,
  run_id uuid NOT NULL,
  branch text NOT NULL CHECK (branch IN ('A', 'B')),
  operation_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, run_id, branch, operation_key),
  UNIQUE (project_id, version_id, run_id, branch, id),
  FOREIGN KEY (project_id, version_id, reader_version)
    REFERENCES reader_maps(project_id, version_id, reader_version)
);
CREATE INDEX reader_evidence_map ON reader_evidence (project_id, version_id, reader_version);

CREATE TABLE reader_observations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  run_id uuid NOT NULL,
  branch text NOT NULL CHECK (branch IN ('A', 'B')),
  operation_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, run_id, branch, operation_key),
  FOREIGN KEY (project_id, scope_id) REFERENCES project_scopes(project_id, id),
  FOREIGN KEY (project_id, version_id, run_id, branch, evidence_id)
    REFERENCES reader_evidence(project_id, version_id, run_id, branch, id)
);
CREATE INDEX reader_observations_positions ON reader_observations (project_id, run_id, branch, created_at, id);
CREATE INDEX reader_observations_evidence ON reader_observations (project_id, version_id, run_id, branch, evidence_id);

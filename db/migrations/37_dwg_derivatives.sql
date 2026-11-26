CREATE TABLE dwg_derivatives (
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_id uuid NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  reader_version text NOT NULL,
  converter_identity text NOT NULL,
  derivative_sha256 text NOT NULL CHECK (derivative_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  format text NOT NULL CHECK (format IN ('dxf','dwg-json')),
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,document_id,version_id,reader_version),
  FOREIGN KEY (project_id,version_id) REFERENCES intake_document_versions(project_id,id),
  FOREIGN KEY (document_id,version_id) REFERENCES intake_document_versions(document_id,id)
);

-- Immutable receipts of a completed package-preparation pass. The mutable pointer
-- is only an admission cache: refresh it under the intake project lock before use.
CREATE TABLE intake_package_preparations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, receipt_id, revision),
  UNIQUE (project_id, receipt_id, id),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id)
);
CREATE TABLE intake_package_preparation_current (
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  PRIMARY KEY (project_id, receipt_id),
  FOREIGN KEY (project_id, receipt_id, manifest_id) REFERENCES intake_package_preparations(project_id, receipt_id, id)
);
CREATE TABLE intake_package_preparation_items (
  manifest_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  map_fingerprint text NOT NULL,
  PRIMARY KEY (manifest_id, version_id),
  FOREIGN KEY (project_id, manifest_id) REFERENCES intake_package_preparations(project_id, id),
  FOREIGN KEY (project_id, version_id) REFERENCES intake_document_versions(project_id, id),
  FOREIGN KEY (version_id, map_fingerprint) REFERENCES harness_package_maps(version_id, fingerprint)
);
CREATE INDEX intake_package_preparation_items_admission ON intake_package_preparation_items(project_id,version_id,map_fingerprint,manifest_id);
CREATE TABLE intake_package_preparation_windows (
  manifest_id uuid NOT NULL,
  project_id uuid NOT NULL,
  window_id uuid NOT NULL REFERENCES harness_package_windows(id),
  PRIMARY KEY (manifest_id,window_id),
  FOREIGN KEY (project_id,manifest_id) REFERENCES intake_package_preparations(project_id,id)
);
CREATE INDEX intake_package_preparation_windows_admission ON intake_package_preparation_windows(project_id,window_id,manifest_id);

-- Historical model reports have no asserted preparation provenance.
ALTER TABLE preliminary_package_reviews ADD COLUMN preparation_id uuid;
ALTER TABLE preliminary_package_reviews ADD FOREIGN KEY (project_id, receipt_id, preparation_id)
  REFERENCES intake_package_preparations(project_id, receipt_id, id);

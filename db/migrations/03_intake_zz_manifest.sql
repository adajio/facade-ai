ALTER TABLE intake_receipts
  ADD COLUMN manifest_mode text CHECK (manifest_mode IN ('once', 'open')),
  ADD COLUMN manifest_version integer CHECK (manifest_version > 0),
  ADD CHECK ((manifest_mode IS NULL) = (manifest_version IS NULL));

ALTER TABLE intake_uploads ADD UNIQUE (receipt_id, id);

CREATE TABLE intake_manifest_items (
  receipt_id uuid NOT NULL REFERENCES intake_receipts(id),
  id uuid NOT NULL,
  added_version integer NOT NULL CHECK (added_version > 0),
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('file', 'archive', 'link')),
  relative_path text,
  size bigint CHECK (size >= 0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text,
  scope_ids uuid[],
  replaces_version_id uuid REFERENCES intake_document_versions(id),
  upload_id uuid UNIQUE,
  import_id uuid UNIQUE,
  accepted_at timestamptz,
  excluded_at timestamptz,
  excluded_by uuid REFERENCES users(id),
  exclusion_reason text,
  PRIMARY KEY (receipt_id, id),
  UNIQUE (receipt_id, added_version, position),
  FOREIGN KEY (receipt_id, upload_id) REFERENCES intake_uploads(receipt_id, id),
  FOREIGN KEY (receipt_id, import_id) REFERENCES intake_imports(receipt_id, id),
  CHECK ((kind = 'link' AND relative_path IS NULL AND size IS NULL AND sha256 IS NULL AND upload_id IS NULL)
      OR (kind <> 'link' AND relative_path IS NOT NULL AND size IS NOT NULL AND sha256 IS NOT NULL AND import_id IS NULL)),
  CHECK (accepted_at IS NULL OR excluded_at IS NULL),
  CHECK ((excluded_at IS NULL) = (excluded_by IS NULL) AND (excluded_at IS NULL) = (exclusion_reason IS NULL))
);
CREATE INDEX intake_manifest_remaining ON intake_manifest_items(receipt_id)
  WHERE accepted_at IS NULL AND excluded_at IS NULL;

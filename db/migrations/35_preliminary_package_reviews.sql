-- These are model drafts tied to one intake, never engineering decisions or letters.
CREATE TABLE preliminary_package_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
  model text NOT NULL CHECK (model = 'gpt-6.1-terra'),
  stage text NOT NULL,
  input_generation bigint NOT NULL,
  inventory jsonb NOT NULL CHECK (jsonb_typeof(inventory) = 'array'),
  scope_note text NOT NULL,
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  draft_text text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts(project_id, id),
  UNIQUE (project_id, content_hash)
);
CREATE INDEX preliminary_package_reviews_page ON preliminary_package_reviews (project_id, created_at DESC, id DESC);

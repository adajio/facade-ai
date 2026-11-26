-- Idempotent publication of one batch of new native observations against its parent report.
ALTER TABLE preliminary_package_reviews ADD COLUMN previous_report_id uuid REFERENCES preliminary_package_reviews(id);
ALTER TABLE preliminary_package_reviews ADD COLUMN revision_key text CHECK (revision_key ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX preliminary_review_revision_key ON preliminary_package_reviews(project_id, receipt_id, revision_key) WHERE revision_key IS NOT NULL;

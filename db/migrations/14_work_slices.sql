CREATE TABLE work_slices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '30 minutes',
    payload jsonb NOT NULL,
    UNIQUE (project_id, fingerprint)
);
CREATE INDEX work_slices_project_created ON work_slices (project_id, created_at DESC, id);
CREATE INDEX work_slices_expiry ON work_slices (expires_at);
CREATE INDEX intake_events_receipt ON intake_events (receipt_id, id DESC);

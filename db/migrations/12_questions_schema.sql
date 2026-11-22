CREATE TABLE inquiry_observations (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id),
    scope_id uuid NOT NULL REFERENCES project_scopes(id),
    stage text NOT NULL,
    version_id uuid NOT NULL,
    property_key text NOT NULL,
    variant_key text NOT NULL,
    subject_names text[] NOT NULL,
    source jsonb NOT NULL,
    superseded boolean NOT NULL DEFAULT false
);

CREATE INDEX inquiry_observations_search_idx
    ON inquiry_observations (scope_id, stage, property_key, variant_key, id);
CREATE INDEX inquiry_observations_version_idx
    ON inquiry_observations (scope_id, stage, version_id);

CREATE TABLE inquiry_superseded_versions (
    scope_id uuid NOT NULL REFERENCES project_scopes(id),
    stage text NOT NULL,
    version_id uuid NOT NULL,
    PRIMARY KEY (scope_id, stage, version_id)
);

CREATE TABLE inquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    scope_id uuid NOT NULL REFERENCES project_scopes(id),
    stage text NOT NULL,
    slice_id uuid,
    catalog_version_id uuid,
    anchor_id uuid REFERENCES inquiry_observations(id),
    assessment_question_id uuid,
    generation_id uuid,
    subject jsonb NOT NULL,
    property_key text NOT NULL,
    variant_key text NOT NULL,
    subject_names text[] NOT NULL,
    version integer NOT NULL DEFAULT 1,
    search_version integer NOT NULL DEFAULT 1,
    needs_review boolean NOT NULL DEFAULT false
);

CREATE INDEX inquiries_scope_idx ON inquiries (scope_id, stage, property_key, variant_key, id);

CREATE TABLE inquiry_jobs (
    inquiry_id uuid PRIMARY KEY REFERENCES inquiries(id),
    search_version integer NOT NULL,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0
);

CREATE INDEX inquiry_jobs_ready_idx ON inquiry_jobs (available_at, inquiry_id);

CREATE TABLE inquiry_search_results (
    inquiry_id uuid NOT NULL REFERENCES inquiries(id),
    search_version integer NOT NULL,
    state text NOT NULL CHECK (state IN ('empty', 'partial', 'verified')),
    limitations text[] NOT NULL,
    candidates jsonb NOT NULL,
    pairs jsonb NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (inquiry_id, search_version)
);

CREATE TABLE inquiry_decisions (
    inquiry_id uuid NOT NULL REFERENCES inquiries(id),
    version integer NOT NULL,
    search_version integer NOT NULL,
    author_id uuid NOT NULL REFERENCES users(id),
    action text NOT NULL CHECK (action IN ('accept', 'correct', 'reject')),
    reason text NOT NULL,
    answer text,
    candidate_ids uuid[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (inquiry_id, version),
    FOREIGN KEY (inquiry_id, search_version) REFERENCES inquiry_search_results(inquiry_id, search_version)
);

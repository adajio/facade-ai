CREATE TABLE facade_assessment_contexts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    kind text NOT NULL CHECK (kind IN ('facade', 'common')),
    facade_id uuid,
    CHECK ((kind = 'facade') = (facade_id IS NOT NULL)),
    UNIQUE (project_id, id),
    UNIQUE NULLS NOT DISTINCT (project_id, kind, facade_id)
);

-- The assessment series key predates package assessment contexts. Existing series
-- retain their scope key and foreign key. A package series has a subject context
-- instead, and never creates a project_scopes row or a permission grant.
ALTER TABLE assessment_series
    DROP CONSTRAINT assessment_series_scope_id_fkey,
    ADD COLUMN assessment_context_id uuid,
    ADD COLUMN access_scope_id uuid GENERATED ALWAYS AS (
        CASE WHEN assessment_context_id IS NULL THEN scope_id END
    ) STORED,
    ADD CHECK (assessment_context_id IS NULL OR assessment_context_id = scope_id),
    ADD FOREIGN KEY (project_id, access_scope_id) REFERENCES project_scopes(project_id, id),
    ADD FOREIGN KEY (project_id, assessment_context_id) REFERENCES facade_assessment_contexts(project_id, id);

CREATE TABLE facade_assessment_snapshots (
    project_id uuid NOT NULL REFERENCES projects(id),
    version integer NOT NULL CHECK (version > 0),
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, version)
);

CREATE TABLE facade_assessment_observations (
    project_id uuid NOT NULL REFERENCES projects(id),
    ref text NOT NULL,
    observation_id uuid NOT NULL REFERENCES reader_observations(id),
    payload jsonb NOT NULL,
    PRIMARY KEY (project_id, ref)
);

ALTER TABLE letters
    ALTER COLUMN scope_id DROP NOT NULL,
    ADD COLUMN assessment_context_id uuid,
    ADD CHECK (num_nonnulls(scope_id, assessment_context_id) = 1),
    ADD FOREIGN KEY (project_id, assessment_context_id) REFERENCES facade_assessment_contexts(project_id, id);

CREATE TABLE facade_source_replacements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id uuid NOT NULL REFERENCES assessment_questions(id),
    catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
    author_id uuid NOT NULL REFERENCES users(id),
    reason text NOT NULL,
    replaced jsonb NOT NULL,
    replacements jsonb NOT NULL,
    receipt_ids uuid[] NOT NULL CHECK (cardinality(receipt_ids) > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX facade_replacements_by_question
    ON facade_source_replacements (question_id, catalog_version_id, created_at);

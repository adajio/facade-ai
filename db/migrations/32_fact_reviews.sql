CREATE TABLE facade_fact_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id uuid NOT NULL REFERENCES projects(id),
  assessment_version integer NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) > 0),
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, assessment_version) REFERENCES facade_assessment_snapshots(project_id, version)
);

CREATE TABLE facade_fact_review_members (
  review_id uuid NOT NULL REFERENCES facade_fact_reviews(id),
  observation_id uuid NOT NULL REFERENCES reader_observations(id),
  binding_key text NOT NULL,
  PRIMARY KEY (review_id, observation_id)
);

CREATE INDEX facade_fact_reviews_project ON facade_fact_reviews(project_id, sequence DESC);
CREATE INDEX facade_fact_review_members_observation ON facade_fact_review_members(observation_id, review_id);

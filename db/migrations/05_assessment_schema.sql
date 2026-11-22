CREATE TABLE assessment_series (
  scope_id uuid PRIMARY KEY REFERENCES project_scopes (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  UNIQUE (project_id, scope_id)
);

CREATE TABLE assessment_revisions (
  scope_id uuid NOT NULL REFERENCES assessment_series (scope_id),
  version integer NOT NULL CHECK (version > 0),
  catalog_version_id uuid,
  source_token text NOT NULL,
  scope jsonb NOT NULL,
  limitations jsonb NOT NULL,
  input_generation bigint NOT NULL CHECK (input_generation >= 0),
  change jsonb NOT NULL,
  conclusion jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_id, version)
);

CREATE TABLE assessment_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id uuid NOT NULL REFERENCES assessment_series (scope_id),
  position_id text NOT NULL,
  part_id text NOT NULL,
  UNIQUE (scope_id, position_id, part_id),
  UNIQUE (scope_id, id)
);

CREATE TABLE assessment_question_revisions (
  scope_id uuid NOT NULL,
  question_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  assessment_version integer NOT NULL,
  dependency_version integer NOT NULL CHECK (dependency_version > 0),
  active boolean NOT NULL,
  requirement jsonb NOT NULL,
  review jsonb,
  machine jsonb NOT NULL,
  decision jsonb,
  previous_decision_id uuid,
  PRIMARY KEY (question_id, version),
  FOREIGN KEY (scope_id, question_id) REFERENCES assessment_questions (scope_id, id),
  FOREIGN KEY (scope_id, assessment_version) REFERENCES assessment_revisions (scope_id, version)
);

CREATE INDEX assessment_question_revisions_by_scope
  ON assessment_question_revisions (scope_id, question_id, assessment_version DESC);

CREATE TABLE assessment_updates (
  scope_id uuid NOT NULL REFERENCES assessment_series (scope_id),
  event_id uuid NOT NULL,
  input jsonb NOT NULL,
  assessment_version integer NOT NULL,
  FOREIGN KEY (scope_id, assessment_version) REFERENCES assessment_revisions (scope_id, version),
  PRIMARY KEY (scope_id, event_id)
);

CREATE TABLE harness_research_events (
  job_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, sequence)
);

CREATE TABLE harness_generations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  input_generation bigint NOT NULL,
  source_token text NOT NULL,
  sealed_at timestamptz
);

CREATE INDEX harness_generations_scope ON harness_generations(project_id, scope_id, input_generation);

CREATE TABLE harness_primary_places (
  generation_id uuid NOT NULL REFERENCES harness_generations(id),
  obligation_id uuid NOT NULL UNIQUE,
  version_id uuid NOT NULL,
  unit_key text NOT NULL,
  branch text NOT NULL CHECK (branch IN ('A', 'B')),
  place jsonb NOT NULL,
  question_id uuid,
  PRIMARY KEY (generation_id, version_id, unit_key, branch)
);

CREATE TABLE harness_review_results (
  generation_id uuid NOT NULL REFERENCES harness_generations(id),
  dispute_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('lead', 'A', 'B')),
  result jsonb NOT NULL,
  PRIMARY KEY (generation_id, dispute_id, stage)
);

CREATE TABLE harness_document_maps (
  version_id uuid PRIMARY KEY REFERENCES intake_reader_jobs(version_id),
  project_id uuid NOT NULL,
  physical_units jsonb NOT NULL,
  format text NOT NULL
);

CREATE TABLE harness_observations (
  observation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  generation_id uuid NOT NULL REFERENCES harness_generations(id),
  question_id uuid NOT NULL,
  job_id uuid NOT NULL,
  finding jsonb NOT NULL,
  PRIMARY KEY (generation_id, observation_id)
);
CREATE INDEX harness_observations_question ON harness_observations(generation_id, question_id);

-- Invalidate the gateway generation in the same commit that makes a new input
-- applicable. Dispatching after finalize alone would leave a paid-review race.
CREATE FUNCTION harness_invalidate_intake_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE gateway_generations g SET current = false
  WHERE g.project_id = NEW.project_id AND g.current
    AND (NEW.scope_ids IS NULL OR g.scope_id = ANY(NEW.scope_ids))
    AND EXISTS (SELECT 1 FROM harness_generations h WHERE h.id = g.generation_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_invalidate_on_intake
  AFTER INSERT ON intake_holds FOR EACH ROW
  EXECUTE FUNCTION harness_invalidate_intake_generation();

CREATE FUNCTION harness_invalidate_catalog_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    UPDATE gateway_generations g SET current = false
    WHERE g.project_id = NEW.id AND g.current
      AND EXISTS (SELECT 1 FROM harness_generations h WHERE h.id = g.generation_id);
  ELSE
    UPDATE gateway_generations g SET current = false
    WHERE g.scope_id = NEW.id AND g.current
      AND EXISTS (SELECT 1 FROM harness_generations h WHERE h.id = g.generation_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_invalidate_on_catalog
  AFTER UPDATE OF catalog_version_id ON projects FOR EACH ROW
  WHEN (OLD.catalog_version_id IS DISTINCT FROM NEW.catalog_version_id)
  EXECUTE FUNCTION harness_invalidate_catalog_generation();
CREATE TRIGGER harness_invalidate_on_scope
  AFTER UPDATE OF version ON project_scopes FOR EACH ROW
  WHEN (OLD.version IS DISTINCT FROM NEW.version)
  EXECUTE FUNCTION harness_invalidate_catalog_generation();

CREATE TABLE harness_disputes (
  generation_id uuid NOT NULL REFERENCES harness_generations(id),
  question_id uuid NOT NULL,
  id uuid NOT NULL UNIQUE,
  a_observation_id uuid NOT NULL,
  b_observation_id uuid NOT NULL,
  PRIMARY KEY (generation_id, question_id, a_observation_id, b_observation_id)
);

CREATE TABLE harness_map_retries (
  job_id uuid PRIMARY KEY REFERENCES intake_reader_jobs(id),
  reason text NOT NULL,
  retry_at timestamptz NOT NULL
);

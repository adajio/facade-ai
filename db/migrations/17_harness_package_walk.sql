CREATE TABLE harness_package_structures (
  window_id uuid PRIMARY KEY REFERENCES harness_package_windows(id),
  evidence_id uuid REFERENCES reader_evidence(id),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks)='array'),
  limitation text
);

CREATE TABLE harness_package_structure_retries (
  window_id uuid PRIMARY KEY REFERENCES harness_package_windows(id),
  reason text NOT NULL,
  retry_at timestamptz NOT NULL,
  failures integer NOT NULL CHECK (failures > 0)
);

CREATE TABLE harness_package_block_checks (
  window_id uuid NOT NULL REFERENCES harness_package_structures(window_id),
  job_id uuid NOT NULL REFERENCES gateway_jobs(id),
  block_id text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES reader_evidence(id),
  reviewed boolean NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (job_id, block_id)
);

CREATE TABLE harness_package_followups (
  root_job_id uuid NOT NULL REFERENCES harness_package_branches(job_id),
  job_id uuid UNIQUE NOT NULL REFERENCES gateway_jobs(id),
  window_id uuid NOT NULL REFERENCES harness_package_windows(id),
  branch text NOT NULL CHECK (branch IN ('A','B')),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks)='array'),
  plan_key text NOT NULL,
  PRIMARY KEY (root_job_id,plan_key)
);
CREATE INDEX harness_package_followups_window ON harness_package_followups(window_id);

CREATE TABLE harness_package_semantic_checks (
  job_id uuid NOT NULL REFERENCES gateway_jobs(id),
  window_id uuid NOT NULL REFERENCES harness_package_windows(id),
  branch text NOT NULL CHECK (branch IN ('A','B')),
  reader_version text NOT NULL,
  applicability_epoch bigint NOT NULL CHECK (applicability_epoch>=0),
  scope_epoch bigint NOT NULL CHECK (scope_epoch>=0),
  catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
  stage text NOT NULL,
  facade_id uuid,
  position_id text NOT NULL,
  disposition text NOT NULL DEFAULT 'supported' CHECK (disposition IN ('supported','alternatives_checked')),
  subject text,
  reason text CHECK (disposition='supported' OR length(trim(reason))>0 AND reason IS NOT NULL),
  basis_ids uuid[] NOT NULL CHECK (cardinality(basis_ids)>0),
  CONSTRAINT harness_package_semantic_check_unique
    UNIQUE NULLS NOT DISTINCT (job_id,catalog_version_id,stage,facade_id,position_id,disposition,subject,applicability_epoch,scope_epoch)
);

CREATE TABLE harness_semantic_epochs (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  epoch bigint NOT NULL CHECK (epoch>0)
);
CREATE TABLE harness_semantic_scope_epochs (
  project_id uuid NOT NULL REFERENCES projects(id),
  scope_key text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch>0),
  PRIMARY KEY (project_id,scope_key)
);

CREATE FUNCTION harness_advance_semantic_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO harness_semantic_epochs(project_id,epoch) VALUES(NEW.id,1)
  ON CONFLICT(project_id) DO UPDATE SET epoch=harness_semantic_epochs.epoch+1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_semantic_epoch AFTER UPDATE OF project_stage,catalog_version_id,confirmed_facade_kinds ON projects
  FOR EACH ROW WHEN ((OLD.project_stage,OLD.catalog_version_id,OLD.confirmed_facade_kinds)
    IS DISTINCT FROM (NEW.project_stage,NEW.catalog_version_id,NEW.confirmed_facade_kinds))
  EXECUTE FUNCTION harness_advance_semantic_epoch();

CREATE FUNCTION harness_advance_semantic_scope_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_project uuid;
BEGIN
  SELECT project_id INTO STRICT target_project FROM harness_package_facts WHERE id=NEW.fact_id;
  INSERT INTO harness_semantic_scope_epochs(project_id,scope_key,epoch)
  SELECT target_project,scope_key,1 FROM (
    SELECT item->>'id' AS scope_key FROM jsonb_array_elements(NEW.candidates) item
    UNION
    SELECT item->>'id' FROM harness_package_bindings b CROSS JOIN LATERAL jsonb_array_elements(b.candidates) item
      WHERE b.fact_id=NEW.fact_id AND b.version=NEW.version-1
    UNION
    SELECT 'common' WHERE NEW.state='common' OR EXISTS (
      SELECT 1 FROM harness_package_bindings b WHERE b.fact_id=NEW.fact_id AND b.version=NEW.version-1 AND b.state='common')
  ) affected WHERE scope_key IS NOT NULL
  ON CONFLICT(project_id,scope_key) DO UPDATE SET epoch=harness_semantic_scope_epochs.epoch+1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_semantic_scope_epoch AFTER INSERT ON harness_package_bindings
  FOR EACH ROW WHEN (NEW.version>1) EXECUTE FUNCTION harness_advance_semantic_scope_epoch();

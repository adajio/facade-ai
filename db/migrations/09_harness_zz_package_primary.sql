ALTER TABLE reader_observations ALTER COLUMN scope_id DROP NOT NULL;

CREATE SEQUENCE harness_package_turn;
CREATE TABLE harness_package_projects (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  generation_id uuid NOT NULL UNIQUE REFERENCES gateway_generations(generation_id),
  last_turn bigint NOT NULL DEFAULT 0,
  profile_hash text
);

CREATE TABLE harness_package_maps (
  project_id uuid NOT NULL REFERENCES harness_package_projects(project_id),
  version_id uuid NOT NULL REFERENCES intake_reader_jobs(version_id),
  fingerprint text NOT NULL,
  reader_version text,
  requested_reader_version text,
  physical_proof boolean NOT NULL DEFAULT false,
  format text NOT NULL,
  refusal text,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (version_id, fingerprint)
);
CREATE UNIQUE INDEX harness_package_current_map ON harness_package_maps(version_id) WHERE active;
CREATE INDEX harness_package_maps_project ON harness_package_maps(project_id) WHERE active;

CREATE TABLE harness_package_windows (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES harness_package_projects(project_id),
  version_id uuid NOT NULL,
  map_fingerprint text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  place jsonb NOT NULL,
  FOREIGN KEY (version_id, map_fingerprint) REFERENCES harness_package_maps(version_id, fingerprint),
  UNIQUE (version_id, map_fingerprint, ordinal)
);
CREATE INDEX harness_package_window_project ON harness_package_windows(project_id,version_id,map_fingerprint,ordinal);

CREATE TABLE harness_package_branches (
  window_id uuid NOT NULL REFERENCES harness_package_windows(id),
  branch text NOT NULL CHECK (branch IN ('A','B')),
  profile_hash text NOT NULL,
  route_revision text,
  settings jsonb,
  job_id uuid UNIQUE REFERENCES gateway_jobs(id),
  blocker_job_id uuid REFERENCES gateway_jobs(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (window_id,branch,profile_hash)
);
CREATE UNIQUE INDEX harness_package_current_branch ON harness_package_branches(window_id,branch) WHERE active;

CREATE TABLE harness_package_facts (
  id uuid PRIMARY KEY REFERENCES reader_observations(id),
  project_id uuid NOT NULL REFERENCES harness_package_projects(project_id),
  window_id uuid NOT NULL REFERENCES harness_package_windows(id),
  job_id uuid NOT NULL REFERENCES gateway_jobs(id),
  attribute text,
  source_role text NOT NULL,
  design_stage text,
  revision text,
  revision_status text NOT NULL,
  basis jsonb NOT NULL,
  subject_register jsonb,
  materials jsonb NOT NULL CHECK (jsonb_typeof(materials)='array')
);
CREATE INDEX harness_package_fact_project ON harness_package_facts(project_id,window_id,id);

CREATE TABLE harness_package_bindings (
  fact_id uuid NOT NULL REFERENCES harness_package_facts(id),
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('identified','common','unclear','unidentified')),
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates)='array'),
  quote text,
  reason text NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fact_id, version)
);

-- Legacy transition checks match physical units across questions, scopes and generations.
CREATE INDEX harness_package_prior_primary ON gateway_jobs
  (project_id, subject_id, ((payload#>>'{place,unitId}')), purpose)
  WHERE purpose IN ('primary_a','primary_b');

CREATE TABLE harness_package_map_retries (
  version_id uuid PRIMARY KEY REFERENCES intake_reader_jobs(version_id),
  reason text NOT NULL,
  retry_at timestamptz NOT NULL
);

CREATE FUNCTION harness_publish_package_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_project uuid;
BEGIN
  IF TG_TABLE_NAME = 'harness_package_bindings' THEN
    SELECT project_id INTO STRICT target_project FROM harness_package_facts WHERE id=NEW.fact_id;
  ELSIF TG_TABLE_NAME = 'harness_package_branches' THEN
    SELECT project_id INTO STRICT target_project FROM harness_package_windows WHERE id=NEW.window_id;
  ELSE
    target_project := NEW.project_id;
  END IF;
  INSERT INTO supplement_event_publications(project_id,type,payload)
  VALUES(target_project,'package-analysis.changed','{}'::jsonb);
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_package_map_changed AFTER INSERT OR UPDATE OF active ON harness_package_maps
  FOR EACH ROW EXECUTE FUNCTION harness_publish_package_change();
CREATE TRIGGER harness_package_binding_changed AFTER INSERT ON harness_package_bindings
  FOR EACH ROW EXECUTE FUNCTION harness_publish_package_change();
CREATE TRIGGER harness_package_branch_changed AFTER INSERT OR UPDATE OF active,job_id,blocker_job_id ON harness_package_branches
  FOR EACH ROW EXECUTE FUNCTION harness_publish_package_change();
CREATE TRIGGER harness_package_job_changed AFTER UPDATE OF state,reason ON gateway_jobs
  FOR EACH ROW WHEN (NEW.target_kind='package' AND
    (OLD.state IS DISTINCT FROM NEW.state OR OLD.reason IS DISTINCT FROM NEW.reason))
  EXECUTE FUNCTION harness_publish_package_change();

CREATE TABLE harness_package_review_pairs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES harness_package_projects(project_id),
  generation_id uuid NOT NULL REFERENCES gateway_generations(generation_id),
  a_fact_id uuid NOT NULL REFERENCES harness_package_facts(id),
  b_fact_id uuid NOT NULL REFERENCES harness_package_facts(id),
  a_binding_version integer NOT NULL,
  b_binding_version integer NOT NULL,
  proof jsonb NOT NULL,
  wire_proof jsonb NOT NULL,
  assignment jsonb NOT NULL,
  signature text NOT NULL,
  verification_profiles jsonb NOT NULL,
  lead_job_id uuid UNIQUE REFERENCES gateway_jobs(id),
  a_job_id uuid UNIQUE REFERENCES gateway_jobs(id),
  b_job_id uuid UNIQUE REFERENCES gateway_jobs(id),
  UNIQUE (project_id,signature),
  UNIQUE (a_fact_id,b_fact_id,a_binding_version,b_binding_version)
);

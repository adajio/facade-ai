CREATE TABLE harness_facade_discovery (
  fact_id uuid PRIMARY KEY REFERENCES harness_package_facts(id),
  mentions jsonb NOT NULL CHECK (jsonb_typeof(mentions)='array'),
  resolved boolean NOT NULL DEFAULT false
);

CREATE TABLE harness_facade_discovery_dirty (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  replaced_versions uuid[] NOT NULL DEFAULT '{}'
);

CREATE TABLE harness_facade_profile_proofs (
  project_id uuid NOT NULL REFERENCES projects(id),
  facade_id uuid NOT NULL,
  fingerprint text NOT NULL,
  version_ids uuid[] NOT NULL,
  PRIMARY KEY(project_id,facade_id)
);

CREATE VIEW harness_stale_facade_profiles AS
SELECT p.project_id,p.facade_id FROM harness_facade_profile_proofs p
JOIN harness_facade_discovery_dirty d USING(project_id)
WHERE p.version_ids && d.replaced_versions;

CREATE TABLE harness_facade_identity_aliases (
  project_id uuid NOT NULL REFERENCES projects(id),
  identity_key text NOT NULL,
  facade_id uuid NOT NULL,
  label text NOT NULL,
  PRIMARY KEY(project_id,identity_key)
);

INSERT INTO harness_facade_discovery_dirty(project_id)
SELECT DISTINCT project_id FROM harness_package_facts;

CREATE FUNCTION harness_mark_facade_discovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  predecessor uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM harness_package_projects WHERE project_id=NEW.project_id) THEN
    IF TG_TABLE_NAME='intake_occurrences' THEN
      SELECT replaces_version_id INTO predecessor FROM intake_document_versions WHERE id=NEW.version_id;
    ELSIF TG_TABLE_NAME='harness_package_maps' AND TG_OP='UPDATE' THEN
      IF OLD.active AND NOT NEW.active THEN
        predecessor := NEW.version_id;
      END IF;
    END IF;
    INSERT INTO harness_facade_discovery_dirty(project_id,replaced_versions)
    VALUES (NEW.project_id,CASE WHEN predecessor IS NULL THEN '{}'::uuid[] ELSE ARRAY[predecessor] END)
    ON CONFLICT(project_id) DO UPDATE SET changed_at=clock_timestamp(),
      replaced_versions=ARRAY(SELECT DISTINCT id FROM unnest(harness_facade_discovery_dirty.replaced_versions||EXCLUDED.replaced_versions) id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER harness_facade_discovery_fact AFTER INSERT ON harness_package_facts
  FOR EACH ROW EXECUTE FUNCTION harness_mark_facade_discovery();
CREATE TRIGGER harness_facade_discovery_map AFTER INSERT OR UPDATE OF active ON harness_package_maps
  FOR EACH ROW EXECUTE FUNCTION harness_mark_facade_discovery();
CREATE TRIGGER harness_facade_discovery_occurrence AFTER INSERT OR UPDATE OF state,version_id ON intake_occurrences
  FOR EACH ROW WHEN (NEW.state='accepted') EXECUTE FUNCTION harness_mark_facade_discovery();

CREATE OR REPLACE FUNCTION harness_advance_semantic_scope_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_project uuid;
BEGIN
  -- The initial automatic proposal was never eligible for a semantic check.
  IF NEW.actor_id IS NULL AND EXISTS (
    SELECT 1 FROM harness_facade_discovery d WHERE d.fact_id=NEW.fact_id AND NOT d.resolved
  ) THEN RETURN NEW;
  END IF;
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

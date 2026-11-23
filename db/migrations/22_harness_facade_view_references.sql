ALTER TABLE harness_facade_discovery
  ADD COLUMN discovery_version integer NOT NULL DEFAULT 1 CHECK (discovery_version>0),
  ADD COLUMN prior_mentions jsonb CHECK (jsonb_typeof(prior_mentions)='array');

-- Hold derived profiles while the local worker reinterprets their issued evidence.
-- Original observations, binding versions and gateway effects are unaffected.
INSERT INTO harness_facade_discovery_dirty(project_id,replaced_versions)
SELECT f.project_id,array_agg(DISTINCT o.version_id) FROM harness_facade_discovery d
JOIN harness_package_facts f ON f.id=d.fact_id
JOIN reader_observations o ON o.id=f.id GROUP BY f.project_id
ON CONFLICT(project_id) DO UPDATE SET changed_at=clock_timestamp(),
  replaced_versions=ARRAY(SELECT DISTINCT id FROM unnest(harness_facade_discovery_dirty.replaced_versions||EXCLUDED.replaced_versions) id);

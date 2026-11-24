-- Reinterpret active bindings with the new claim boundaries. Stored evidence,
-- previous interpretations and manual binding versions remain available.
INSERT INTO harness_facade_discovery_dirty(project_id,replaced_versions)
SELECT f.project_id,array_agg(DISTINCT o.version_id) FROM harness_facade_discovery d
JOIN harness_package_facts f ON f.id=d.fact_id
JOIN reader_observations o ON o.id=f.id
WHERE d.discovery_version<3 GROUP BY f.project_id
ON CONFLICT(project_id) DO UPDATE SET changed_at=clock_timestamp(),
  replaced_versions=ARRAY(SELECT DISTINCT id FROM unnest(harness_facade_discovery_dirty.replaced_versions||EXCLUDED.replaced_versions) id);

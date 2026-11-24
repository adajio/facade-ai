CREATE VIEW harness_live_review_pairs AS
SELECT d.*, g.project_id, g.scope_id, g.sealed, a.finding AS a, b.finding AS b,
       a.finding->'citation'->>'sha256' <> b.finding->'citation'->>'sha256'
       AND ia.version_id <> ib.version_id AS independent_sources
FROM harness_disputes d
JOIN gateway_generations g ON g.generation_id=d.generation_id AND g.current
JOIN project_scopes s ON s.id=g.scope_id AND s.project_id=g.project_id
JOIN projects p ON p.id=g.project_id
JOIN harness_observations a ON a.generation_id=d.generation_id AND a.question_id=d.question_id
  AND a.observation_id=d.a_observation_id AND a.project_id=g.project_id AND a.scope_id=g.scope_id
JOIN harness_observations b ON b.generation_id=d.generation_id AND b.question_id=d.question_id
  AND b.observation_id=d.b_observation_id AND b.project_id=g.project_id AND b.scope_id=g.scope_id
JOIN inquiry_observations ia ON ia.id=a.observation_id AND ia.scope_id=g.scope_id AND NOT ia.superseded
JOIN inquiry_observations ib ON ib.id=b.observation_id AND ib.scope_id=g.scope_id AND NOT ib.superseded
WHERE a.finding->'citation'->>'branch'='A' AND b.finding->'citation'->>'branch'='B'
  AND a.finding->>'kind'='value' AND b.finding->>'kind'='value'
  AND NOT EXISTS (
    SELECT 1 FROM inquiry_superseded_versions old
    WHERE old.scope_id=g.scope_id AND (
      old.version_id IN (ia.version_id,ib.version_id)
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          coalesce(a.finding#>'{citation,components}','[]'::jsonb) ||
          coalesce(b.finding#>'{citation,components}','[]'::jsonb)
        ) part WHERE part#>>'{source,versionId}'=old.version_id::text
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM inquiry_replaced_places old
    WHERE old.question_id=d.question_id AND old.catalog_version_id=p.catalog_version_id AND old.scope_version=s.version
      AND ((old.version_id=ia.version_id AND old.address=ia.source->'address')
        OR (old.version_id=ib.version_id AND old.address=ib.source->'address'))
  );

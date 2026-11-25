ALTER TABLE catalog_versions
  DROP CONSTRAINT catalog_default_profile_complete,
  ADD CONSTRAINT catalog_default_profile_complete CHECK (
    (default_stage IS NULL AND default_facade_kinds IS NULL AND approval_reference IS NULL)
    OR (default_stage IS NOT NULL AND default_facade_kinds IS NOT NULL AND approval_reference IS NOT NULL
        AND (cardinality(default_facade_kinds) > 0 OR default_stage = 'Стадия 1'))
  );

UPDATE projects
SET project_stage = 'Стадия 1', version = version + 1
WHERE intake_mode AND project_stage IS NULL;

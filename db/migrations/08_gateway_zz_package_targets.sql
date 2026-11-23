-- Preserve every existing identifier, effect key and scope assignment.
ALTER TABLE gateway_jobs DROP CONSTRAINT gateway_jobs_project_id_scope_id_generation_id_fkey;
ALTER TABLE gateway_generations DROP CONSTRAINT gateway_generations_pkey;
ALTER TABLE gateway_generations ALTER COLUMN scope_id DROP NOT NULL;
ALTER TABLE gateway_generations
  ADD COLUMN target_kind text GENERATED ALWAYS AS (CASE WHEN scope_id IS NULL THEN 'package' ELSE 'scope' END) STORED,
  ADD COLUMN target_id uuid GENERATED ALWAYS AS (coalesce(scope_id, project_id)) STORED,
  ADD UNIQUE (project_id, target_kind, target_id, generation_id);
CREATE UNIQUE INDEX gateway_current_package_generation ON gateway_generations(project_id)
  WHERE current AND scope_id IS NULL;
ALTER TABLE gateway_jobs ALTER COLUMN scope_id DROP NOT NULL;
ALTER TABLE gateway_jobs
  ADD COLUMN target_kind text GENERATED ALWAYS AS (CASE WHEN scope_id IS NULL THEN 'package' ELSE 'scope' END) STORED,
  ADD COLUMN target_id uuid GENERATED ALWAYS AS (coalesce(scope_id, project_id)) STORED,
  ADD FOREIGN KEY (project_id, target_kind, target_id, generation_id)
    REFERENCES gateway_generations(project_id, target_kind, target_id, generation_id);
ALTER TABLE gateway_attempts ALTER COLUMN scope_id DROP NOT NULL;

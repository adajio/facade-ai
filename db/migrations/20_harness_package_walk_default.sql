-- Keep the previous default for existing projects, including intake projects not yet mapped.
ALTER TABLE projects ADD COLUMN package_walk_default boolean NOT NULL DEFAULT false;
ALTER TABLE projects ALTER COLUMN package_walk_default SET DEFAULT true;

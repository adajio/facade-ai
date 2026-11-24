ALTER TABLE harness_package_maps
  ADD COLUMN physical_basis_id text,
  ADD COLUMN physical_limitation text,
  ADD CHECK (physical_basis_id IS NULL OR physical_limitation IS NULL);

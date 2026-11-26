-- Keep the active cursor API stable while retaining every reader generation.
CREATE TABLE project_memory_generations (
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  contract integer NOT NULL,
  reader_version text NOT NULL,
  format text NOT NULL,
  total integer NOT NULL CHECK (total >= 0),
  next_ordinal integer NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0 AND next_ordinal <= total),
  physical_limitation text,
  PRIMARY KEY (version_id,contract,reader_version),
  FOREIGN KEY (project_id,version_id,reader_version) REFERENCES reader_maps(project_id,version_id,reader_version)
);
INSERT INTO project_memory_generations(project_id,version_id,contract,reader_version,format,total,next_ordinal,physical_limitation)
SELECT project_id,version_id,contract,reader_version,format,total,next_ordinal,physical_limitation
FROM project_memory_versions WHERE reader_version IS NOT NULL AND total IS NOT NULL;

-- Preserve cursors written by old workers and by existing ingestion fixtures as well.
CREATE FUNCTION project_memory_save_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reader_version IS NOT NULL AND NEW.total IS NOT NULL AND NEW.format IS NOT NULL THEN
    INSERT INTO project_memory_generations(project_id,version_id,contract,reader_version,format,total,next_ordinal,physical_limitation)
      VALUES(NEW.project_id,NEW.version_id,NEW.contract,NEW.reader_version,NEW.format,NEW.total,NEW.next_ordinal,NEW.physical_limitation)
      ON CONFLICT(version_id,contract,reader_version) DO UPDATE SET format=EXCLUDED.format,total=EXCLUDED.total,
        next_ordinal=EXCLUDED.next_ordinal,physical_limitation=EXCLUDED.physical_limitation;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_memory_save_generation AFTER INSERT OR UPDATE OF reader_version,format,total,next_ordinal,physical_limitation
ON project_memory_versions FOR EACH ROW EXECUTE FUNCTION project_memory_save_generation();

ALTER TABLE project_memory_blocks RENAME TO project_memory_blocks_all;
ALTER TABLE project_memory_blocks_all ADD COLUMN reader_version text;
UPDATE project_memory_blocks_all b SET reader_version=v.reader_version FROM project_memory_versions v
WHERE v.project_id=b.project_id AND v.version_id=b.version_id AND v.contract=b.contract;
ALTER TABLE project_memory_blocks_all ALTER COLUMN reader_version SET NOT NULL;
ALTER TABLE project_memory_blocks_all DROP CONSTRAINT project_memory_blocks_version_id_contract_ordinal_key;
ALTER TABLE project_memory_blocks_all DROP CONSTRAINT project_memory_blocks_version_id_contract_unit_id_key;
ALTER TABLE project_memory_blocks_all ADD UNIQUE(version_id,contract,reader_version,ordinal);
ALTER TABLE project_memory_blocks_all ADD UNIQUE(version_id,contract,reader_version,unit_id);
ALTER TABLE project_memory_blocks_all ADD FOREIGN KEY(project_id,version_id,reader_version)
  REFERENCES reader_maps(project_id,version_id,reader_version);

-- Existing callers see only the active generation. Explicit old block IDs remain in the full table.
CREATE VIEW project_memory_blocks AS SELECT b.id,b.project_id,b.version_id,b.contract,b.ordinal,b.unit_id,b.address,
  b.artifact_sha256,b.artifact_size,b.limitations,b.remaining FROM project_memory_blocks_all b WHERE EXISTS (
  SELECT 1 FROM project_memory_versions v WHERE v.project_id=b.project_id AND v.version_id=b.version_id
    AND v.contract=b.contract AND v.reader_version=b.reader_version
);
CREATE FUNCTION project_memory_default_block_reader() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reader_version IS NULL THEN
    SELECT reader_version INTO NEW.reader_version FROM project_memory_versions
      WHERE project_id=NEW.project_id AND version_id=NEW.version_id AND contract=NEW.contract;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_memory_default_block_reader BEFORE INSERT ON project_memory_blocks_all
FOR EACH ROW EXECUTE FUNCTION project_memory_default_block_reader();

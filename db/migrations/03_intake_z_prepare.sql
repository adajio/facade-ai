ALTER TABLE intake_uploads
  ADD COLUMN prepared_object_key text,
  ADD COLUMN prepared_media_type text,
  ADD CHECK ((prepared_object_key IS NULL) = (prepared_media_type IS NULL));

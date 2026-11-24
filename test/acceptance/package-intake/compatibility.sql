\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
DO $fence$
BEGIN
  IF current_database() !~ '^test_pkgintake_(base|legacy_restore)_[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'Use the isolated legacy or restore acceptance database';
  END IF;
END
$fence$;

SELECT jsonb_pretty(jsonb_build_object(
  'projects', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, catalog_version_id, version) ORDER BY id)
    FROM projects), '[]'::jsonb),
  'scopes', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, project_id, stage, version) ORDER BY id)
    FROM project_scopes), '[]'::jsonb),
  'receipts', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, project_id, number, sealed_at) ORDER BY id)
    FROM intake_receipts), '[]'::jsonb),
  'occurrences', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, receipt_id, version_id, relative_path, state, inventory_pending) ORDER BY id)
    FROM intake_occurrences), '[]'::jsonb),
  'versions', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, document_id, original_id, media_type, replaces_version_id) ORDER BY id)
    FROM intake_document_versions), '[]'::jsonb),
  'originals', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, object_key, size, sha256) ORDER BY id)
    FROM intake_originals), '[]'::jsonb),
  'uploads', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, occurrence_id, size, sha256, state, expires_at) ORDER BY id)
    FROM intake_uploads), '[]'::jsonb),
  'parts', COALESCE((SELECT jsonb_agg(jsonb_build_array(upload_id, number, byte_offset, length, sha256) ORDER BY upload_id, number)
    FROM intake_parts), '[]'::jsonb),
  'citations', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, version_id, evidence_id, run_id, branch, md5(payload::text)) ORDER BY id)
    FROM reader_observations), '[]'::jsonb),
  'evidence', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, version_id, reader_version, request_sha256, md5(payload::text)) ORDER BY id)
    FROM reader_evidence), '[]'::jsonb),
  'gatewayJobs', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, scope_id, generation_id, job_key, state) ORDER BY id)
    FROM gateway_jobs), '[]'::jsonb),
  'attempts', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, job_id, effect_key, request_hash, route_id, revision, state,
    ceiling_usd_nanos, md5(receipt::text)) ORDER BY id) FROM gateway_attempts), '[]'::jsonb),
  'journalBinding', COALESCE((SELECT jsonb_agg(to_jsonb(binding)) FROM gateway_journal_binding binding), '[]'::jsonb)
));
COMMIT;

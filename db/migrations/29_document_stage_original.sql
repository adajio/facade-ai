ALTER TABLE document_stage_confirmations
  ALTER COLUMN evidence_id DROP NOT NULL,
  ADD COLUMN original_basis jsonb,
  ADD CONSTRAINT document_stage_origin CHECK (
    num_nonnulls(evidence_id, original_basis) = 1 AND
    (original_basis IS NULL OR (original_basis->>'provenanceKind' = 'engineer_override') IS TRUE)
  );

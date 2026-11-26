ALTER TABLE gateway_primary DROP CONSTRAINT gateway_primary_state_check;
ALTER TABLE gateway_primary ADD CONSTRAINT gateway_primary_state_check
  CHECK (state IN ('pending', 'completed', 'final_refusal', 'partial'));

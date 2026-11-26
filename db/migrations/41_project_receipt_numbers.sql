-- The old identity remains the stable cursor for clients paginating across this upgrade.
ALTER TABLE intake_receipts RENAME COLUMN number TO server_sequence;
ALTER INDEX intake_receipts_project_number RENAME TO intake_receipts_project_sequence;
ALTER TABLE intake_receipts ADD COLUMN number bigint;
WITH numbered AS (
  SELECT id,row_number() OVER (PARTITION BY project_id ORDER BY server_sequence,id) AS project_number FROM intake_receipts
)
UPDATE intake_receipts r SET number=n.project_number FROM numbered n WHERE n.id=r.id;
ALTER TABLE intake_receipts ALTER COLUMN number SET NOT NULL;
ALTER TABLE intake_receipts ADD UNIQUE (project_id,number);

CREATE TABLE intake_receipt_counters (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_number bigint NOT NULL CHECK (last_number>0)
);
INSERT INTO intake_receipt_counters SELECT project_id,max(number) FROM intake_receipts GROUP BY project_id;

CREATE FUNCTION intake_assign_receipt_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO intake_receipt_counters AS c(project_id,last_number) VALUES(NEW.project_id,1)
    ON CONFLICT(project_id) DO UPDATE SET last_number=c.last_number+1 RETURNING last_number INTO NEW.number;
  RETURN NEW;
END
$$;
CREATE TRIGGER intake_assign_receipt_number BEFORE INSERT ON intake_receipts FOR EACH ROW EXECUTE FUNCTION intake_assign_receipt_number();

-- Idempotent command responses must reopen with the same number as the current inventory.
UPDATE command_receipts c SET response_body=jsonb_set(c.response_body,'{number}',to_jsonb(r.number))
FROM intake_receipts r WHERE c.operation='intake.create_receipt' AND c.project_id=r.project_id
  AND c.response_body->>'receiptId'=r.id::text AND c.response_body->'number' IS DISTINCT FROM to_jsonb(r.number);

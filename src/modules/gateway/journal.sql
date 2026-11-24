-- Apply to a separate PostgreSQL database outside the application VPS.
-- This file also upgrades an existing journal in place. Apply it in one transaction.
-- Provision exactly one ledger row with the installation's pinned UUID.
CREATE TABLE IF NOT EXISTS gateway_external_ledger (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ledger_id uuid NOT NULL,
  limit_usd_nanos bigint NOT NULL DEFAULT 10000000000 CHECK (limit_usd_nanos BETWEEN 1 AND 10000000000),
  frozen boolean NOT NULL DEFAULT false
);

ALTER TABLE gateway_external_ledger ADD COLUMN IF NOT EXISTS limit_usd_nanos bigint NOT NULL
  DEFAULT 10000000000 CHECK (limit_usd_nanos BETWEEN 1 AND 10000000000);

CREATE TABLE IF NOT EXISTS gateway_external_project_budgets (
  project_id uuid PRIMARY KEY,
  limit_usd_nanos bigint NOT NULL CHECK (limit_usd_nanos BETWEEN 1 AND 10000000000)
);

CREATE TABLE IF NOT EXISTS gateway_external_attempts (
  id uuid PRIMARY KEY,
  effect_key text NOT NULL,
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  route_id text NOT NULL,
  purpose text NOT NULL,
  ceiling_usd_nanos bigint NOT NULL CHECK (ceiling_usd_nanos BETWEEN 1 AND 10000000000),
  metadata jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared','sending','unknown','paid','rejected','cancelled')),
  receipt jsonb,
  spent_usd_nanos bigint NOT NULL DEFAULT 0 CHECK (spent_usd_nanos >= 0),
  slot_until timestamptz,
  started_at timestamptz,
  created_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_external_effect_owner ON gateway_external_attempts(effect_key)
  WHERE state IN ('prepared','sending','unknown','paid');
CREATE INDEX IF NOT EXISTS gateway_external_attempt_history ON gateway_external_attempts(effect_key,created_order DESC);
CREATE INDEX IF NOT EXISTS gateway_external_route_latest ON gateway_external_attempts(route_id,started_at DESC);
CREATE INDEX IF NOT EXISTS gateway_external_primary ON gateway_external_attempts(generation_id)
  WHERE purpose IN ('primary_a','primary_b') AND state IN ('sending','unknown');
CREATE UNIQUE INDEX IF NOT EXISTS gateway_external_charge ON gateway_external_attempts((receipt->>'providerId'))
  WHERE state='paid';

CREATE INDEX IF NOT EXISTS gateway_external_attempt_project ON gateway_external_attempts(project_id);

CREATE OR REPLACE FUNCTION gateway_budget_balances(target_project uuid, budget jsonb)
RETURNS TABLE(scope text, limit_usd_nanos bigint, spent numeric, reserved numeric, active numeric)
LANGUAGE sql STABLE AS $$
  WITH limits AS (
    SELECT 'installation' AS scope, l.limit_usd_nanos
    FROM gateway_external_ledger l WHERE singleton
    UNION ALL
    SELECT 'project', p.limit_usd_nanos FROM gateway_external_project_budgets p WHERE p.project_id=target_project
    UNION ALL
    SELECT 'package', 10000000000 FROM gateway_external_project_budgets p
    WHERE p.project_id=target_project AND budget->>'packageId' IS NOT NULL
    UNION ALL
    SELECT 'copilot', p.limit_usd_nanos / 10 FROM gateway_external_project_budgets p
    WHERE p.project_id=target_project AND budget->>'initiatedBy'='copilot'
  )
  SELECT l.scope, l.limit_usd_nanos, coalesce(sum(a.spent_usd_nanos),0),
    coalesce(sum(a.ceiling_usd_nanos) FILTER (WHERE a.state IN ('prepared','sending','unknown')),0),
    coalesce(sum(a.ceiling_usd_nanos) FILTER (WHERE a.state='prepared' OR
      (a.state='sending' AND a.slot_until>statement_timestamp())),0)
  FROM limits l
  LEFT JOIN gateway_external_attempts a ON (
    l.scope='installation' OR (a.project_id=target_project AND CASE l.scope
      WHEN 'project' THEN true
      -- History without an attribution counts conservatively in each applicable sublimit.
      WHEN 'package' THEN a.metadata->'budget' IS NULL OR a.metadata->'budget'->>'packageId'=budget->>'packageId'
      WHEN 'copilot' THEN a.metadata->'budget' IS NULL OR a.metadata->'budget'->>'initiatedBy'='copilot'
    END)
  )
  GROUP BY l.scope,l.limit_usd_nanos;
$$;

CREATE OR REPLACE FUNCTION gateway_budget_block(target_project uuid, budget jsonb, additional bigint, own_prepared bigint)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN budget IS NULL AND EXISTS (
      SELECT 1 FROM gateway_external_project_budgets WHERE project_id=target_project
    ) THEN 'budget_attribution_required'
    WHEN budget IS NOT NULL AND (
      jsonb_typeof(budget) <> 'object'
      OR coalesce(budget->>'initiatedBy','') NOT IN ('background','copilot')
      OR budget - 'initiatedBy' - 'packageId' <> '{}'::jsonb
      OR (budget ? 'packageId' AND coalesce(budget->>'packageId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
    ) THEN 'invalid_budget_attribution'
    WHEN budget IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM gateway_external_project_budgets WHERE project_id=target_project
    ) THEN 'budget_project_unconfigured'
    ELSE (
      SELECT CASE WHEN spent+reserved+additional-active+own_prepared <= limit_usd_nanos THEN 'budget_reserve_wait'
        WHEN scope='copilot' THEN 'copilot_budget_exhausted' ELSE 'budget_exhausted' END
      FROM gateway_budget_balances(target_project,budget)
      WHERE spent+reserved+additional > limit_usd_nanos
      ORDER BY spent+reserved+additional-active+own_prepared <= limit_usd_nanos, scope <> 'copilot'
      LIMIT 1
    ) END;
$$;

CREATE OR REPLACE FUNCTION gateway_lock_budget_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM gateway_external_ledger WHERE singleton FOR UPDATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER gateway_guard_project_budget
  BEFORE INSERT OR UPDATE OR DELETE ON gateway_external_project_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION gateway_lock_budget_configuration();

CREATE OR REPLACE FUNCTION gateway_pin_budget_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gateway budget attribution is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER gateway_guard_budget_identity BEFORE UPDATE OF project_id,metadata ON gateway_external_attempts
  FOR EACH ROW WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.metadata->'budget' IS DISTINCT FROM NEW.metadata->'budget')
  EXECUTE FUNCTION gateway_pin_budget_attribution();

-- The same guard covers writers using the previous gateway binary.
CREATE OR REPLACE FUNCTION gateway_guard_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_frozen boolean;
  blocked text;
BEGIN
  SELECT frozen INTO STRICT ledger_frozen FROM gateway_external_ledger WHERE singleton FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    blocked := gateway_budget_block(NEW.project_id, NEW.metadata->'budget', NEW.ceiling_usd_nanos, 0);
  ELSE
    blocked := gateway_budget_block(NEW.project_id, NEW.metadata->'budget', 0, NEW.ceiling_usd_nanos);
  END IF;
  IF ledger_frozen OR blocked IS NOT NULL THEN
    RAISE EXCEPTION '%', CASE WHEN ledger_frozen THEN 'budget_frozen'
      WHEN blocked='budget_exhausted' THEN 'gateway budget exhausted' ELSE blocked END USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER gateway_guard_reservation BEFORE INSERT ON gateway_external_attempts
  FOR EACH ROW WHEN (NEW.state = 'prepared') EXECUTE FUNCTION gateway_guard_budget();
CREATE OR REPLACE TRIGGER gateway_guard_dispatch BEFORE UPDATE OF state ON gateway_external_attempts
  FOR EACH ROW WHEN (OLD.state = 'prepared' AND NEW.state = 'sending') EXECUTE FUNCTION gateway_guard_budget();

CREATE TABLE IF NOT EXISTS gateway_external_reconciliation (
  actor_id text NOT NULL,
  operation_key text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES gateway_external_attempts(id),
  authority text NOT NULL CHECK (authority='gateway:reconcile'),
  reason_ref text NOT NULL,
  fingerprint text NOT NULL,
  previous jsonb NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id,operation_key)
);

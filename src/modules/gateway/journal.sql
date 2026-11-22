-- Apply once to a separate PostgreSQL database outside the application VPS.
-- Provision exactly one ledger row with the installation's pinned UUID.
CREATE TABLE gateway_external_ledger (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ledger_id uuid NOT NULL,
  frozen boolean NOT NULL DEFAULT false
);

CREATE TABLE gateway_external_attempts (
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
CREATE UNIQUE INDEX gateway_external_effect_owner ON gateway_external_attempts(effect_key)
  WHERE state IN ('prepared','sending','unknown','paid');
CREATE INDEX gateway_external_attempt_history ON gateway_external_attempts(effect_key,created_order DESC);
CREATE INDEX gateway_external_route_latest ON gateway_external_attempts(route_id,started_at DESC);
CREATE INDEX gateway_external_primary ON gateway_external_attempts(generation_id)
  WHERE purpose IN ('primary_a','primary_b') AND state IN ('sending','unknown');
CREATE UNIQUE INDEX gateway_external_charge ON gateway_external_attempts((receipt->>'providerId'))
  WHERE state='paid';

CREATE TABLE gateway_external_reconciliation (
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

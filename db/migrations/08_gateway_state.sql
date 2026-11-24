CREATE TABLE gateway_generations (
  project_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  generation_id uuid NOT NULL UNIQUE,
  current boolean NOT NULL DEFAULT true,
  sealed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (project_id, scope_id, generation_id)
);
CREATE UNIQUE INDEX gateway_current_generation ON gateway_generations(project_id, scope_id) WHERE current;

CREATE TABLE gateway_primary (
  generation_id uuid NOT NULL REFERENCES gateway_generations(generation_id),
  id text NOT NULL,
  branch text NOT NULL CHECK (branch IN ('A', 'B')),
  place text NOT NULL CHECK (length(place) > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'final_refusal')),
  evidence_ref text,
  PRIMARY KEY (generation_id, id),
  UNIQUE (generation_id, place, branch),
  CHECK ((state = 'pending') = (evidence_ref IS NULL))
);

CREATE SEQUENCE gateway_project_turn;
CREATE TABLE gateway_projects (
  project_id uuid PRIMARY KEY,
  last_turn bigint NOT NULL DEFAULT 0,
  last_subject text,
  last_purpose text
);

CREATE TABLE gateway_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES gateway_projects(project_id),
  scope_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  job_key text NOT NULL,
  kind text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('local', 'primary_a', 'primary_b', 'review')),
  subject_id text NOT NULL,
  obligation_id text,
  spec_hash text NOT NULL,
  payload jsonb NOT NULL,
  priority integer NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'leased', 'held', 'done')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_epoch integer NOT NULL DEFAULT 0,
  worker_id text,
  lease_until timestamptz,
  reason text,
  next_action text,
  cursor jsonb,
  result jsonb,
  UNIQUE (generation_id, job_key),
  UNIQUE (generation_id, obligation_id),
  FOREIGN KEY (project_id, scope_id, generation_id)
    REFERENCES gateway_generations(project_id, scope_id, generation_id),
  FOREIGN KEY (generation_id, obligation_id) REFERENCES gateway_primary(generation_id, id),
  CHECK ((purpose IN ('primary_a','primary_b')) = (obligation_id IS NOT NULL)),
  CHECK ((state = 'leased') = (worker_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX gateway_job_lookup ON gateway_jobs(project_id, state, available_at);
CREATE INDEX gateway_job_lease ON gateway_jobs(lease_until) WHERE state = 'leased';

CREATE TABLE gateway_routes (
  id text PRIMARY KEY,
  revision text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('managed', 'openrouter')),
  enabled boolean NOT NULL,
  max_request_bytes integer NOT NULL CHECK (max_request_bytes > 0),
  ceiling_usd_nanos bigint NOT NULL CHECK (ceiling_usd_nanos BETWEEN 1 AND 10000000000),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 3600000),
  min_interval_ms integer NOT NULL CHECK (min_interval_ms BETWEEN 0 AND 3600000)
);
CREATE TABLE gateway_grants (
  project_id uuid NOT NULL,
  route_id text NOT NULL REFERENCES gateway_routes(id),
  data_class text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('primary_a','primary_b','review')),
  revision text NOT NULL,
  allowed boolean NOT NULL,
  PRIMARY KEY (project_id, route_id, data_class, purpose)
);

CREATE TABLE gateway_journal_binding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ledger_id uuid NOT NULL
);
CREATE TABLE gateway_attempts (
  id uuid PRIMARY KEY,
  ledger_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('primary_a','primary_b','review')),
  previous_rejected_id uuid,
  effect_key text NOT NULL,
  request_hash text NOT NULL,
  route_id text NOT NULL,
  revision text NOT NULL,
  ceiling_usd_nanos bigint NOT NULL CHECK (ceiling_usd_nanos > 0),
  state text NOT NULL CHECK (state IN ('reserved','prepared','sending','unknown','paid','rejected','cancelled')),
  input_refs jsonb NOT NULL DEFAULT '[]',
  response jsonb,
  response_receipt jsonb,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX gateway_attempt_effect ON gateway_attempts (effect_key, created_at DESC);
CREATE INDEX gateway_attempt_primary ON gateway_attempts (generation_id)
  WHERE purpose IN ('primary_a','primary_b') AND state IN ('reserved','prepared','sending','unknown');
CREATE INDEX gateway_attempt_job ON gateway_attempts(job_id);

CREATE TABLE gateway_outbox_sequence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cursor bigint NOT NULL DEFAULT 0
);
INSERT INTO gateway_outbox_sequence DEFAULT VALUES;
CREATE TABLE gateway_outbox (
  cursor bigint PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES gateway_jobs(id),
  lease_epoch integer NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, lease_epoch, event_type)
);

ALTER TABLE projects ADD COLUMN default_analysis_scenario smallint NOT NULL DEFAULT 2
  CHECK (default_analysis_scenario IN (1, 2));
ALTER TABLE projects ALTER COLUMN default_analysis_scenario SET DEFAULT 1;

ALTER TABLE intake_receipts ADD COLUMN analysis_scenario smallint NOT NULL DEFAULT 2
  CHECK (analysis_scenario IN (1, 2));

ALTER TABLE preliminary_package_reviews DROP CONSTRAINT preliminary_package_reviews_model_check;
ALTER TABLE preliminary_package_reviews ADD CONSTRAINT preliminary_package_reviews_model_check
  CHECK (model IN ('gpt-6.1-terra', 'gemini-3.8-flash'));

CREATE TABLE intake_scenario_one_calls (
  project_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  request_key text NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  provider_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  model text NOT NULL CHECK (model IN ('gemini-3.5-flash-lite', 'gemini-3.8-flash')),
  state text NOT NULL CHECK (state IN ('sending', 'answered', 'rejected')),
  result jsonb,
  PRIMARY KEY (project_id, receipt_id, request_key, request_hash),
  FOREIGN KEY (project_id, receipt_id, preparation_id) REFERENCES intake_package_preparations(project_id, receipt_id, id)
);

ALTER TABLE intake_receipts ADD COLUMN analysis_base_review_id uuid REFERENCES preliminary_package_reviews(id),
  ADD CONSTRAINT intake_analysis_base_scenario CHECK (analysis_base_review_id IS NULL OR analysis_scenario = 1);

CREATE TABLE intake_scenario_one_results (
  review_id uuid PRIMARY KEY REFERENCES preliminary_package_reviews(id),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  coverage_complete boolean NOT NULL,
  requests jsonb NOT NULL CHECK (jsonb_typeof(requests) = 'array')
);

CREATE TABLE intake_scenario_one_letter_events (
  review_id uuid NOT NULL REFERENCES intake_scenario_one_results(review_id),
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('draft', 'sent', 'response')),
  body text NOT NULL,
  request_key text,
  response_state text CHECK (response_state IN ('answered', 'closed', 'refused')),
  CHECK ((request_key IS NULL AND response_state IS NULL) OR
         (kind = 'response' AND request_key IS NOT NULL AND response_state IS NOT NULL)),
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, version)
);

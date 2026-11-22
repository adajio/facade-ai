CREATE TABLE harness_route_bindings (
  job_id uuid PRIMARY KEY REFERENCES gateway_jobs(id),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object')
);

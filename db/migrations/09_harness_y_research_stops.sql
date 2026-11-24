CREATE TABLE harness_research_stops (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES gateway_jobs(id),
  sequence integer NOT NULL,
  resume_requested_at timestamptz,
  resume_requested_by uuid,
  FOREIGN KEY (job_id, sequence) REFERENCES harness_research_events(job_id, sequence),
  UNIQUE (job_id, sequence)
);

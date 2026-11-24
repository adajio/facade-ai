CREATE TABLE copilot_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES access_sessions(id),
  question text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 2000),
  job_id uuid UNIQUE REFERENCES gateway_jobs(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'research_queued', 'answered', 'limited', 'held')),
  reason text,
  research_source_id text,
  result jsonb CHECK (jsonb_typeof(result) = 'object'),
  retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id),
  CHECK ((state IN ('answered', 'limited')) = (result IS NOT NULL))
);
CREATE INDEX copilot_questions_pending ON copilot_questions (created_at,id) WHERE state='pending';
CREATE INDEX copilot_questions_author ON copilot_questions (project_id,user_id,created_at DESC);

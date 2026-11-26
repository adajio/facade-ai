-- Run once per stand after the local worker creates its own single-reader ledger.
-- The managed server records package and job milestones in migration 42.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('facade/local-activity-install',0));
CREATE OR REPLACE FUNCTION reading_activity_local_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,reason,attempt_key,event_time,fields)
  SELECT j.project_id,rj.receipt_id,'model_call',NEW.state,CASE WHEN NEW.state='unknown' THEN 'subscription_outcome_unknown' END,
    NEW.id::text,coalesce(NEW.finished_at,NEW.created_at),jsonb_strip_nulls(jsonb_build_object(
    'jobId',j.id,'versionId',rj.version_id,'model',NEW.model,'effort',NEW.response->>'local_effort','requestSha256',NEW.request_hash,
    'inputTokens',NEW.response#>'{usage,prompt_tokens}','outputTokens',NEW.response#>'{usage,completion_tokens}',
    'elapsedMs',round(extract(epoch FROM (NEW.finished_at-NEW.created_at))*1000)))
    FROM gateway_jobs j JOIN intake_reader_jobs rj ON rj.version_id::text=j.subject_id AND rj.project_id=j.project_id
    WHERE j.id=NEW.job_id AND j.project_id=NEW.project_id ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
CREATE OR REPLACE TRIGGER reading_activity_local_call AFTER INSERT OR UPDATE OF state ON local_terra_calls
 FOR EACH ROW EXECUTE FUNCTION reading_activity_local_turn();
INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,reason,attempt_key,event_time,fields)
SELECT a.project_id,r.receipt_id,'model_call',a.state,CASE WHEN a.state='unknown' THEN 'subscription_outcome_unknown' END,
 a.id::text,coalesce(a.finished_at,a.created_at),jsonb_strip_nulls(jsonb_build_object('jobId',j.id,'versionId',r.version_id,'model',a.model,
 'effort',a.response->>'local_effort','requestSha256',a.request_hash,'inputTokens',a.response#>'{usage,prompt_tokens}',
 'outputTokens',a.response#>'{usage,completion_tokens}','elapsedMs',round(extract(epoch FROM (a.finished_at-a.created_at))*1000),'history','stored'))
FROM local_terra_calls a JOIN gateway_jobs j ON j.id=a.job_id JOIN intake_reader_jobs r ON r.version_id::text=j.subject_id AND r.project_id=j.project_id ON CONFLICT DO NOTHING;
COMMIT;

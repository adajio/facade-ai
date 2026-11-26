-- Operator history: retain scalar diagnostic facts and stable source IDs, never file bodies or prompts.
CREATE TABLE project_reading_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  receipt_id uuid,
  preparation_id uuid,
  stage text NOT NULL,
  status text NOT NULL,
  reason text,
  fields jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(fields)='object'),
  attempt_key text NOT NULL,
  event_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id,receipt_id) REFERENCES intake_receipts(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id,receipt_id,preparation_id) REFERENCES intake_package_preparations(project_id,receipt_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_reading_activity_effect ON project_reading_activity(project_id,stage,attempt_key,status,coalesce(reason,''));
CREATE INDEX project_reading_activity_receipt ON project_reading_activity(project_id,receipt_id,event_time DESC,id DESC);

CREATE FUNCTION reading_activity_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p uuid; r uuid; prep uuid; v uuid; lane text; state text; why text; k text;
  info jsonb := '{}'::jsonb; moment timestamptz := clock_timestamp();
BEGIN
  CASE TG_TABLE_NAME
  WHEN 'projects' THEN
    p:=NEW.id; lane:='project'; state:='created'; k:=p; moment:=NEW.created_at;
  WHEN 'intake_receipts' THEN
    p:=NEW.project_id; r:=NEW.id; lane:='intake'; k:=r;
    state:=CASE WHEN NEW.sealed_at IS NULL THEN 'received' ELSE 'sealed' END;
    moment:=coalesce(NEW.sealed_at,NEW.created_at); info:=jsonb_build_object('number',NEW.number);
  WHEN 'import_jobs' THEN
    p:=NEW.project_id; r:=NEW.receipt_id; lane:='archive'; state:=NEW.status; why:=NEW.reason;
    k:=NEW.id||':'||NEW.attempts; info:=jsonb_build_object('versionId',NEW.version_id,'attempts',NEW.attempts,'expandedBytes',NEW.expanded_bytes);
  WHEN 'harness_package_maps' THEN
    p:=NEW.project_id; v:=NEW.version_id; lane:='file_map'; k:=v||':'||NEW.fingerprint;
    why:=coalesce(NEW.refusal,NEW.physical_limitation);
    state:=CASE WHEN NEW.refusal IS NOT NULL THEN 'limited' ELSE 'mapped' END;
    info:=jsonb_build_object('versionId',v,'format',NEW.format,'readerVersion',NEW.reader_version);
  WHEN 'harness_package_map_retries' THEN
    v:=NEW.version_id; lane:='file_map'; state:='waiting'; why:=NEW.reason; k:=v||':wait:'||txid_current();
    info:=jsonb_build_object('versionId',v,'retryAt',NEW.retry_at);
  WHEN 'project_memory_versions' THEN
    p:=NEW.project_id; v:=NEW.version_id; lane:='index'; k:=v||':'||NEW.contract||':'||coalesce(NEW.reader_version,'')||':'||txid_current();
    IF NEW.last_error IS NOT NULL THEN state:='waiting';why:=NEW.last_error;
    ELSIF NEW.total IS NOT NULL AND NEW.total=NEW.next_ordinal THEN state:='completed';why:=NEW.physical_limitation;
    ELSE RETURN NEW; END IF;
    info:=jsonb_build_object('versionId',v,'units',NEW.next_ordinal,'totalUnits',NEW.total,'format',NEW.format);
  WHEN 'intake_package_preparations' THEN
    p:=NEW.project_id; r:=NEW.receipt_id; prep:=NEW.id; lane:='preparation'; state:='published'; k:=prep;
    moment:=NEW.created_at; info:=(CASE WHEN jsonb_typeof(NEW.manifest->'counts')='object' THEN NEW.manifest->'counts' ELSE '{}'::jsonb END)||jsonb_build_object('revision',NEW.revision);
  WHEN 'gateway_jobs' THEN
    IF NEW.payload->'packageWindow' IS NULL OR NEW.subject_id !~* '^[0-9a-f-]{36}$' THEN RETURN NEW; END IF;
    p:=NEW.project_id; v:=NEW.subject_id::uuid; lane:='detailed_reading'; k:=NEW.id||':'||NEW.lease_epoch;
    state:=CASE WHEN NEW.state='done' THEN coalesce(NEW.result->>'kind','done') ELSE NEW.state END; why:=NEW.reason;
    info:=jsonb_build_object('versionId',v,'jobId',NEW.id,'branch',NEW.payload->>'branch');
  WHEN 'preliminary_package_reviews' THEN
    p:=NEW.project_id; r:=NEW.receipt_id; prep:=NEW.preparation_id; lane:='review_saved'; state:='published';
    k:=NEW.id;moment:=NEW.created_at;
    SELECT jsonb_build_object('reviewId',NEW.id,'previousReviewId',NEW.previous_report_id,'criteria',jsonb_array_length(NEW.rows),
      'letterChanged',CASE WHEN prev.id IS NOT NULL THEN NEW.draft_text IS DISTINCT FROM prev.draft_text END,
      'changedCriteria',CASE WHEN prev.id IS NOT NULL THEN (SELECT count(*) FROM jsonb_array_elements(NEW.rows) n
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prev.rows) oldrow WHERE oldrow=n)) END,
      'timeFromReceiptMs',greatest(0,round(extract(epoch FROM (NEW.created_at-rc.created_at))*1000)))
      INTO info FROM intake_receipts rc LEFT JOIN preliminary_package_reviews prev ON prev.id=NEW.previous_report_id WHERE rc.id=r;
  END CASE;
  IF v IS NOT NULL THEN SELECT j.project_id,j.receipt_id INTO p,r FROM intake_reader_jobs j WHERE j.version_id=v; END IF;
  IF p IS NOT NULL THEN
    INSERT INTO project_reading_activity(project_id,receipt_id,preparation_id,stage,status,reason,fields,attempt_key,event_time)
    VALUES(p,r,prep,lane,state,why,jsonb_strip_nulls(info),k,moment) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER reading_activity_project AFTER INSERT ON projects FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_receipt AFTER INSERT OR UPDATE OF sealed_at ON intake_receipts FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_import AFTER INSERT OR UPDATE OF status,reason ON import_jobs FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_map AFTER INSERT ON harness_package_maps FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_wait AFTER INSERT ON harness_package_map_retries FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_new_wait AFTER UPDATE ON harness_package_map_retries FOR EACH ROW WHEN (OLD.reason IS DISTINCT FROM NEW.reason) EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_index_start AFTER INSERT ON project_memory_versions FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_index_end AFTER UPDATE ON project_memory_versions FOR EACH ROW WHEN (
 OLD.last_error IS DISTINCT FROM NEW.last_error OR
 (NEW.total=NEW.next_ordinal AND (OLD.total IS DISTINCT FROM NEW.total OR OLD.next_ordinal IS DISTINCT FROM NEW.next_ordinal OR OLD.reader_version IS DISTINCT FROM NEW.reader_version))
) EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_preparation AFTER INSERT ON intake_package_preparations FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_job_start AFTER INSERT ON gateway_jobs FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_job_state AFTER UPDATE ON gateway_jobs FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.reason IS DISTINCT FROM NEW.reason) EXECUTE FUNCTION reading_activity_trigger();
CREATE TRIGGER reading_activity_review AFTER INSERT ON preliminary_package_reviews FOR EACH ROW EXECUTE FUNCTION reading_activity_trigger();

-- Restore historical milestones from primary records. A current state without its transition timestamp
-- is explicitly dated at installation; it does not assert when the original transition happened.
INSERT INTO project_reading_activity(project_id,stage,status,attempt_key,event_time,fields)
 SELECT id,'project','created',id::text,created_at,'{"history":"stored"}' FROM projects;
INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,attempt_key,event_time,fields)
 SELECT project_id,id,'intake',x.status,id::text,x.t,jsonb_build_object('number',number,'history','stored')
 FROM intake_receipts CROSS JOIN LATERAL (VALUES('received',created_at),('sealed',sealed_at)) x(status,t) WHERE x.t IS NOT NULL;
INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,attempt_key,event_time,fields,reason)
 SELECT project_id,receipt_id,'archive',status,id||':'||attempts,updated_at,jsonb_strip_nulls(jsonb_build_object(
  'versionId',version_id,'attempts',attempts,'expandedBytes',expanded_bytes,'history','last_recorded_state')),reason FROM import_jobs;
INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,attempt_key,fields,reason)
 SELECT j.project_id,j.receipt_id,'file_map',CASE WHEN m.refusal IS NULL THEN 'mapped' ELSE 'limited' END,
  m.version_id||':'||m.fingerprint,jsonb_strip_nulls(jsonb_build_object('versionId',m.version_id,'format',m.format,
   'readerVersion',m.reader_version,'activeAtInstall',m.active,'history','state_at_install')),coalesce(m.refusal,m.physical_limitation)
 FROM harness_package_maps m JOIN intake_reader_jobs j USING(version_id);
INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,attempt_key,event_time,fields,reason)
 SELECT j.project_id,j.receipt_id,'index',CASE WHEN m.last_error IS NULL THEN 'completed' ELSE 'waiting' END,
 m.version_id||':'||m.contract||':baseline',m.updated_at,jsonb_strip_nulls(jsonb_build_object('versionId',m.version_id,'units',m.next_ordinal,'totalUnits',m.total,
 'format',m.format,'history','last_recorded_state')),coalesce(m.last_error,m.physical_limitation)
 FROM project_memory_versions m JOIN intake_reader_jobs j USING(version_id) WHERE m.last_error IS NOT NULL OR m.total=m.next_ordinal;
INSERT INTO project_reading_activity(project_id,receipt_id,preparation_id,stage,status,attempt_key,event_time,fields)
 SELECT project_id,receipt_id,id,'preparation','published',id::text,created_at,(CASE WHEN jsonb_typeof(manifest->'counts')='object' THEN manifest->'counts' ELSE '{}'::jsonb END)||jsonb_build_object('revision',revision,'history','stored') FROM intake_package_preparations;
INSERT INTO project_reading_activity(project_id,receipt_id,preparation_id,stage,status,attempt_key,event_time,fields)
 SELECT r.project_id,r.receipt_id,r.preparation_id,'review_saved','published',r.id::text,r.created_at,
 jsonb_strip_nulls(jsonb_build_object('reviewId',r.id,'previousReviewId',prev.id,'criteria',jsonb_array_length(r.rows),
 'letterChanged',CASE WHEN prev.id IS NOT NULL THEN r.draft_text IS DISTINCT FROM prev.draft_text END,
 'changedCriteria',CASE WHEN prev.id IS NOT NULL THEN (SELECT count(*) FROM jsonb_array_elements(r.rows) n WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(prev.rows) oldrow WHERE oldrow=n)) END,
 'timeFromReceiptMs',round(extract(epoch FROM (r.created_at-rc.created_at))*1000),'history','stored'))
 FROM preliminary_package_reviews r JOIN intake_receipts rc ON rc.id=r.receipt_id LEFT JOIN preliminary_package_reviews prev ON prev.id=r.previous_report_id;
INSERT INTO project_reading_activity(project_id,receipt_id,stage,status,attempt_key,reason,fields)
 SELECT j.project_id,i.receipt_id,'detailed_reading',CASE WHEN j.state='done' THEN coalesce(j.result->>'kind','done') ELSE j.state END,
 j.id||':'||j.lease_epoch,j.reason,jsonb_strip_nulls(jsonb_build_object('versionId',j.subject_id,'jobId',j.id,'branch',j.payload->>'branch','history','state_at_install'))
 FROM gateway_jobs j JOIN intake_reader_jobs i ON i.version_id::text=j.subject_id AND i.project_id=j.project_id WHERE j.payload->'packageWindow' IS NOT NULL;

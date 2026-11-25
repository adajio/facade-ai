ALTER TABLE inquiries
    ALTER COLUMN scope_id DROP NOT NULL,
    ALTER COLUMN stage DROP NOT NULL,
    ADD COLUMN assessment_context_id uuid,
    ADD COLUMN package_snapshot_version integer,
    ADD COLUMN package_source jsonb,
    ADD FOREIGN KEY (project_id, assessment_context_id) REFERENCES facade_assessment_contexts(project_id, id),
    ADD FOREIGN KEY (project_id, package_snapshot_version) REFERENCES facade_assessment_snapshots(project_id, version),
    ADD CHECK (num_nonnulls(scope_id, assessment_context_id) = 1),
    ADD CHECK ((assessment_context_id IS NOT NULL) = (package_source IS NOT NULL)),
    ADD CHECK ((assessment_context_id IS NOT NULL) = (package_snapshot_version IS NOT NULL)),
    ADD CHECK (scope_id IS NULL OR stage IS NOT NULL);

CREATE INDEX inquiries_assessment_context ON inquiries(project_id, assessment_context_id, id)
    WHERE assessment_context_id IS NOT NULL;

ALTER TABLE inquiry_search_results ADD COLUMN package_result jsonb;

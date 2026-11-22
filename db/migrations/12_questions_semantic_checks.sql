CREATE TABLE inquiry_semantic_checks (
    inquiry_id uuid NOT NULL REFERENCES inquiries(id),
    generation_id uuid NOT NULL REFERENCES harness_generations(id),
    dispute_id uuid NOT NULL,
    settled_at timestamptz,
    PRIMARY KEY (inquiry_id, generation_id, dispute_id)
);

CREATE INDEX inquiry_semantic_checks_pending ON inquiry_semantic_checks (generation_id, dispute_id)
    WHERE settled_at IS NULL;

CREATE TABLE supplement_projection_heads (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    retained_after bigint NOT NULL DEFAULT 0 CHECK (retained_after BETWEEN 0 AND cursor),
    slice_id uuid NOT NULL
);

CREATE TABLE supplement_project_events (
    project_id uuid NOT NULL REFERENCES supplement_projection_heads(project_id) ON DELETE CASCADE,
    cursor bigint NOT NULL CHECK (cursor > 0),
    slice_id uuid NOT NULL UNIQUE,
    type text NOT NULL CHECK (type <> ''),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, cursor)
);

CREATE TABLE supplement_receipt_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    receipt_id uuid NOT NULL,
    letter_id uuid NOT NULL,
    sent_id uuid NOT NULL,
    item_id uuid,
    actor_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (project_id, receipt_id) REFERENCES intake_receipts (project_id, id),
    FOREIGN KEY (letter_id, sent_id) REFERENCES letter_sends (letter_id, id),
    UNIQUE NULLS NOT DISTINCT (project_id, receipt_id, letter_id, sent_id, item_id)
);

CREATE INDEX supplement_receipt_links_sent_idx ON supplement_receipt_links (project_id, letter_id, sent_id);

-- Publish after domain writes. Updating the head serializes committed positions
-- within the project, including multiple events from the same transaction.
CREATE FUNCTION supplement_publish_event(p_project_id uuid, p_type text, p_payload jsonb)
RETURNS TABLE (cursor bigint, slice_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
    next_head supplement_projection_heads%ROWTYPE;
BEGIN
    INSERT INTO supplement_projection_heads (project_id, slice_id)
    VALUES (p_project_id, p_project_id) ON CONFLICT (project_id) DO NOTHING;

    UPDATE supplement_projection_heads AS head
    SET cursor = head.cursor + 1,
        retained_after = greatest(0, head.cursor + 1 - 4096),
        slice_id = gen_random_uuid()
    WHERE head.project_id = p_project_id
    RETURNING head.* INTO next_head;

    INSERT INTO supplement_project_events (project_id, cursor, slice_id, type, payload)
    VALUES (p_project_id, next_head.cursor, next_head.slice_id, p_type, p_payload);

    IF next_head.retained_after > 0 THEN
        DELETE FROM supplement_project_events AS prior
        WHERE prior.project_id = p_project_id AND prior.cursor <= next_head.retained_after;
    END IF;
    RETURN QUERY SELECT next_head.cursor, next_head.slice_id;
END;
$$;

CREATE FUNCTION supplement_publish_intake_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM supplement_publish_event(
        NEW.project_id,
        NEW.type,
        jsonb_strip_nulls(jsonb_build_object(
            'receiptId', NEW.receipt_id,
            'holdId', coalesce(NEW.data->'holdId', CASE WHEN NEW.type = 'intake.held' THEN NEW.data->'id' END),
            'generation', NEW.data->'generation',
            'version', NEW.data->'version'
        ))
    );
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER supplement_project_intake_events
AFTER INSERT ON intake_events DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_intake_event();

-- Scope and catalog writes also move the snapshot version. These
-- invalidations run after domain changes, taking the projection lock at commit.
CREATE FUNCTION supplement_publish_scope_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM supplement_publish_event(NEW.project_id, 'scope.changed',
        jsonb_build_object('scopeId', NEW.id, 'version', NEW.version));
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER supplement_project_scope_events
AFTER INSERT OR UPDATE OF version ON project_scopes DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_scope_event();

CREATE FUNCTION supplement_publish_catalog_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM supplement_publish_event(NEW.id, 'catalog.changed',
        jsonb_build_object('catalogVersionId', NEW.catalog_version_id));
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER supplement_project_catalog_events
AFTER UPDATE OF catalog_version_id ON projects DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.catalog_version_id IS DISTINCT FROM NEW.catalog_version_id)
EXECUTE FUNCTION supplement_publish_catalog_event();

-- Other modules enqueue invalidations in the transaction that changes their data.
-- The transient row is consumed at commit, after locks for the command and its
-- receipt have been acquired. A failed transaction never exposes the event.
CREATE TABLE supplement_event_publications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL
);

CREATE FUNCTION supplement_publish_enqueued_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM supplement_publish_event(NEW.project_id, NEW.type, NEW.payload);
    DELETE FROM supplement_event_publications WHERE id = NEW.id;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER supplement_publish_enqueued_events
AFTER INSERT ON supplement_event_publications DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_enqueued_event();

CREATE TABLE supplement_impacts (
    hold_id uuid PRIMARY KEY REFERENCES intake_holds(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION supplement_publish_link_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM supplement_publish_event(NEW.project_id, 'supplement.linked',
        jsonb_build_object('linkId', NEW.id, 'receiptId', NEW.receipt_id,
            'letterId', NEW.letter_id, 'sentId', NEW.sent_id, 'itemId', NEW.item_id));
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER supplement_project_link_events
AFTER INSERT ON supplement_receipt_links DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_link_event();

CREATE FUNCTION supplement_publish_impact_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM supplement_publish_event(NEW.project_id, 'supplement.impact_resolved',
        jsonb_build_object('holdId', NEW.hold_id, 'changes', NEW.changes));
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER supplement_project_impact_events
AFTER INSERT ON supplement_impacts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_impact_event();

CREATE FUNCTION supplement_publish_letter_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    letter_project_id uuid;
    letter_scope_id uuid;
BEGIN
    SELECT project_id, scope_id INTO STRICT letter_project_id, letter_scope_id
    FROM letters WHERE id = NEW.letter_id;
    PERFORM supplement_publish_event(letter_project_id, TG_ARGV[0],
        jsonb_build_object('letterId', NEW.letter_id, 'scopeId', letter_scope_id, 'id', NEW.id));
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER supplement_project_revision_events
AFTER INSERT ON letter_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_letter_event('letter.revision');

CREATE CONSTRAINT TRIGGER supplement_project_sent_events
AFTER INSERT ON letter_sends DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_letter_event('letter.sent');

CREATE CONSTRAINT TRIGGER supplement_project_response_events
AFTER INSERT ON letter_responses DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supplement_publish_letter_event('letter.response');

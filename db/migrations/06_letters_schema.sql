CREATE TABLE letter_counters (
    project_id uuid PRIMARY KEY REFERENCES projects(id),
    last_number integer NOT NULL CHECK (last_number > 0)
);

CREATE TABLE letters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    scope_id uuid NOT NULL,
    number integer NOT NULL CHECK (number > 0),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id, scope_id) REFERENCES project_scopes(project_id, id),
    UNIQUE (project_id, number)
);

CREATE TABLE letter_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    letter_id uuid NOT NULL REFERENCES letters(id),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL CHECK (status IN ('draft', 'confirmed')),
    recipient text NOT NULL,
    layout text NOT NULL CHECK (layout IN ('formal', 'brief')),
    items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
    text text NOT NULL,
    text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (letter_id, version),
    UNIQUE (letter_id, id)
);

CREATE TABLE letter_exports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    letter_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    format text NOT NULL CHECK (format IN ('txt', 'docx')),
    content bytea NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (letter_id, revision_id) REFERENCES letter_revisions(letter_id, id),
    UNIQUE (revision_id, format)
);

CREATE TABLE letter_sends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    letter_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    recipient text NOT NULL,
    items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
    text text NOT NULL,
    text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
    sent_at timestamptz NOT NULL,
    registered_by uuid NOT NULL REFERENCES users(id),
    registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (letter_id, revision_id) REFERENCES letter_revisions(letter_id, id),
    UNIQUE (letter_id, id)
);

CREATE TABLE letter_responses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    letter_id uuid NOT NULL,
    sent_id uuid NOT NULL,
    item_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('response', 'refusal')),
    text text NOT NULL,
    received_at timestamptz NOT NULL,
    registered_by uuid NOT NULL REFERENCES users(id),
    registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (letter_id, sent_id) REFERENCES letter_sends(letter_id, id)
);

CREATE INDEX letter_sends_by_letter ON letter_sends(letter_id, registered_at DESC, id DESC);
CREATE INDEX letter_responses_by_letter ON letter_responses(letter_id, registered_at DESC, id DESC);

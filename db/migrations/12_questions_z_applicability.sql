CREATE TABLE inquiry_source_replacements (
    id uuid PRIMARY KEY,
    question_id uuid NOT NULL REFERENCES assessment_questions(id),
    catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
    scope_version integer NOT NULL CHECK (scope_version > 0),
    author_id uuid NOT NULL REFERENCES users(id),
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    replaced jsonb NOT NULL CHECK (jsonb_typeof(replaced) = 'array'),
    replacements jsonb NOT NULL CHECK (jsonb_typeof(replacements) = 'array'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX inquiry_source_replacements_history ON inquiry_source_replacements (question_id, created_at DESC, id);

CREATE TABLE inquiry_replaced_places (
    replacement_id uuid NOT NULL REFERENCES inquiry_source_replacements(id),
    question_id uuid NOT NULL REFERENCES assessment_questions(id),
    catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
    scope_version integer NOT NULL CHECK (scope_version > 0),
    version_id uuid NOT NULL REFERENCES intake_document_versions(id),
    address jsonb NOT NULL CHECK (jsonb_typeof(address) = 'object'),
    PRIMARY KEY (question_id, catalog_version_id, scope_version, version_id, address)
);

CREATE TABLE inquiry_attribute_aliases (
    question_id uuid NOT NULL REFERENCES assessment_questions(id),
    catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
    scope_version integer NOT NULL CHECK (scope_version > 0),
    alias_key text NOT NULL,
    alias text NOT NULL CHECK (btrim(alias) <> ''),
    author_id uuid NOT NULL REFERENCES users(id),
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'array'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (question_id, catalog_version_id, scope_version, alias_key)
);

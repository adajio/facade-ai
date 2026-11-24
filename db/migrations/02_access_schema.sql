CREATE TABLE organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    login text NOT NULL UNIQUE CHECK (login = lower(btrim(login))),
    password_hash text CHECK (password_hash LIKE '$argon2id$%'),
    state text NOT NULL DEFAULT 'invited' CHECK (state IN ('invited', 'active', 'disabled')),
    org_admin boolean NOT NULL DEFAULT false,
    can_create_project boolean NOT NULL DEFAULT false,
    technical_operator boolean NOT NULL DEFAULT false,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CHECK (state <> 'active' OR password_hash IS NOT NULL)
);

CREATE TABLE access_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX access_sessions_active ON access_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE access_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    purpose text NOT NULL CHECK (purpose IN ('invite', 'reset')),
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    invalidated_at timestamptz
);
CREATE UNIQUE INDEX access_tokens_open ON access_tokens (user_id, purpose)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE access_login_limits (
    bucket bytea PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL CHECK (attempts > 0)
);
CREATE INDEX access_login_limits_expiry ON access_login_limits (expires_at);

-- One-time installation bootstrap, including across concurrent invocations.
CREATE TABLE access_bootstrap (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    user_id uuid NOT NULL REFERENCES users(id)
);

CREATE TABLE catalog_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    catalog_key text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    name text NOT NULL,
    requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'array'),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, catalog_key, revision),
    FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id)
);

CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    name text NOT NULL,
    catalog_version_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions (organization_id, id)
);

CREATE TABLE project_scopes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    stage text NOT NULL,
    name text NOT NULL,
    version integer NOT NULL DEFAULT 1,
    UNIQUE (project_id, id),
    UNIQUE (project_id, stage, name)
);

CREATE TABLE project_memberships (
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('project_manager', 'engineer', 'viewer')),
    scope_id uuid,
    expires_at timestamptz,
    reason text,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
    FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id),
    FOREIGN KEY (project_id, scope_id) REFERENCES project_scopes (project_id, id),
    CHECK (role = 'viewer' OR (scope_id IS NULL AND expires_at IS NULL)),
    CHECK ((expires_at IS NULL AND scope_id IS NULL) OR (expires_at IS NOT NULL AND length(btrim(reason)) > 0 AND reason IS NOT NULL))
);
CREATE UNIQUE INDEX project_memberships_one_owner ON project_memberships (project_id)
    WHERE role = 'project_manager';
CREATE INDEX project_memberships_by_user ON project_memberships (user_id, project_id);

CREATE TABLE scope_requirements (
    scope_id uuid NOT NULL REFERENCES project_scopes(id),
    version integer NOT NULL CHECK (version > 1),
    catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
    requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'array'),
    author_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, version)
);

CREATE TABLE command_receipts (
    organization_id uuid NOT NULL REFERENCES organizations(id),
    user_id uuid NOT NULL REFERENCES users(id),
    project_id uuid REFERENCES projects(id),
    operation text NOT NULL,
    command_key text NOT NULL,
    request_hash bytea NOT NULL,
    response_status smallint NOT NULL CHECK (response_status BETWEEN 200 AND 299),
    response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (organization_id, user_id, project_id, operation, command_key)
);

CREATE TABLE access_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id uuid REFERENCES organizations(id),
    project_id uuid REFERENCES projects(id),
    actor_id uuid REFERENCES users(id),
    role text NOT NULL,
    action text NOT NULL,
    object_id uuid,
    object_version integer,
    outcome text NOT NULL,
    request_id text,
    details jsonb NOT NULL DEFAULT '{}',
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_audit_project ON access_audit (project_id, id);

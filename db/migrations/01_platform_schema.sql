CREATE TABLE IF NOT EXISTS public.facade_schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

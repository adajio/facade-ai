-- Last observation per transport state. Multiple workers may share a database.
CREATE TABLE reader_availability (
  transport_enabled boolean PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL
);

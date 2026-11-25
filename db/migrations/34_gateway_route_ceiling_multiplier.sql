ALTER TABLE gateway_routes ADD COLUMN ceiling_multiplier smallint DEFAULT 1 NOT NULL
  CHECK (ceiling_multiplier BETWEEN 1 AND 10);

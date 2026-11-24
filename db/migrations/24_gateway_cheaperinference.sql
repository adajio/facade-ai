ALTER TABLE gateway_routes DROP CONSTRAINT gateway_routes_transport_check;
ALTER TABLE gateway_routes ADD CONSTRAINT gateway_routes_transport_check
  CHECK (transport IN ('managed', 'openrouter', 'cheaperinference'));

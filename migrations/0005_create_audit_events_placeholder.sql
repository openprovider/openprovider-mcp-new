CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  actor_kind      text NOT NULL CHECK (actor_kind IN ('user','service','system')),
  actor_subject   text NOT NULL,
  event_type      text NOT NULL,
  tool_name       text,
  resource_type   text,
  resource_id     text,
  request_args    jsonb,
  result          jsonb,
  http_status     integer,
  error_code      text,
  trace_id        text,
  span_id         text
  -- prev_hash and row_hash columns added in Phase 7
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_isolation ON audit_events
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Append-only for the app: insert + select only.
GRANT SELECT, INSERT ON audit_events TO app_role;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC, app_role;

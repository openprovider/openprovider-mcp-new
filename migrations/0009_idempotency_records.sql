CREATE TABLE idempotency_records (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  tool_name   text NOT NULL,
  result_json jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_records_isolation ON idempotency_records
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT ON idempotency_records TO app_role;
CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);

CREATE TABLE tenant_keys (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id),
  wrapped_dek  bytea NOT NULL,
  kms_key_arn  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz
);

ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_keys_isolation ON tenant_keys
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_keys TO app_role;

CREATE TABLE openprovider_accounts (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id),
  username            text NOT NULL,
  reseller_id         text,
  cached_token        bytea,
  cached_token_nonce  bytea,
  cached_token_tag    bytea,
  token_expires_at    timestamptz,
  status              text NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected','invalid_credentials','rate_limited')),
  last_verified_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE openprovider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE openprovider_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY op_accounts_isolation ON openprovider_accounts
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON openprovider_accounts TO app_role;

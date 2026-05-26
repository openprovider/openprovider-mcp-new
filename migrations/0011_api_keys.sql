CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  prefix             text NOT NULL,
  hash               text NOT NULL,
  name               text NOT NULL,
  created_by_user_id uuid,
  scopes             text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_keys_isolation ON api_keys
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON api_keys TO app_role;
CREATE INDEX api_keys_prefix ON api_keys (prefix);

CREATE FUNCTION resolve_api_key(p_prefix text)
  RETURNS TABLE (id uuid, tenant_id uuid, hash text, scopes text[], expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, hash, scopes, expires_at, revoked_at FROM api_keys WHERE prefix = p_prefix;
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO app_role;

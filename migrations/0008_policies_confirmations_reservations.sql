-- Policies
CREATE TABLE policies (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  doc                jsonb NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid
);
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
CREATE POLICY policies_isolation ON policies
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON policies TO app_role;

-- Confirmations
CREATE TABLE confirmations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  principal_subject       text NOT NULL,
  tool_name               text NOT NULL,
  args_hash               bytea NOT NULL,
  args_jsonb              jsonb NOT NULL,
  summary_text            text NOT NULL,
  estimated_cost_eur      numeric(12,4) NOT NULL DEFAULT 0,
  required_approver_roles text[] NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz
);
ALTER TABLE confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY confirmations_isolation ON confirmations
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON confirmations TO app_role;
CREATE UNIQUE INDEX confirmations_active_id ON confirmations (id) WHERE consumed_at IS NULL;
CREATE INDEX confirmations_tenant_expiry ON confirmations (tenant_id, expires_at);

-- Spend reservations
CREATE TABLE spend_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  confirmation_id uuid REFERENCES confirmations(id),
  amount_eur      numeric(12,4) NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','released')),
  window_start    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz
);
ALTER TABLE spend_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY spend_reservations_isolation ON spend_reservations
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON spend_reservations TO app_role;
CREATE INDEX spend_reservations_window ON spend_reservations (tenant_id, window_start, status);

-- Seed a default policy whenever a tenant is provisioned. CREATE OR REPLACE the
-- Phase 3 function to also insert the default policy row for the new tenant.
CREATE OR REPLACE FUNCTION resolve_or_provision_tenant(p_subject text, p_email text)
  RETURNS TABLE (tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_new_tenant_id uuid;
BEGIN
  LOOP
    RETURN QUERY
      SELECT u.tenant_id, u.id, u.role FROM users u WHERE u.oauth_subject = p_subject;
    IF FOUND THEN
      RETURN;
    END IF;

    BEGIN
      v_new_tenant_id := gen_random_uuid();
      INSERT INTO tenants (id, name)
        VALUES (v_new_tenant_id, 'tenant for ' || p_subject);
      INSERT INTO policies (tenant_id, doc)
        VALUES (
          v_new_tenant_id,
          '{"version":1,"spend_caps":{"window":"month","limit_eur":0},"tld_allowlist":[],"tld_denylist":[],"tools":{"list_*":"allow","get_*":"allow","check_domain":"allow","register_domain":"confirm","update_domain":"confirm","delete_contact":"confirm","update_contact":"confirm","create_contact":"allow"},"ip_allowlist":[]}'::jsonb
        );
      RETURN QUERY
        INSERT INTO users (tenant_id, email, oauth_subject, role)
        VALUES (v_new_tenant_id, NULLIF(p_email, ''), p_subject, 'owner')
        RETURNING users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- lost the race; subtransaction (incl. tenants + policies) rolled back. Loop.
    END;
  END LOOP;
END;
$$;

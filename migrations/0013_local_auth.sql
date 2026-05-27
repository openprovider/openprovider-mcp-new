ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ALTER COLUMN oauth_subject DROP NOT NULL;
CREATE UNIQUE INDEX users_email_active ON users (lower(email)) WHERE status <> 'deleted';

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  token       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY password_resets_isolation ON password_resets
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON password_resets TO app_role;
CREATE UNIQUE INDEX password_resets_token ON password_resets (token);

DROP FUNCTION IF EXISTS resolve_or_provision_tenant(text, text);

CREATE FUNCTION signup_tenant(p_email text, p_password_hash text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_new_tenant_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(p_email) AND u.status <> 'deleted') THEN
    RETURN QUERY SELECT 'email_taken'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  LOOP
    BEGIN
      v_new_tenant_id := gen_random_uuid();
      INSERT INTO tenants (id, name) VALUES (v_new_tenant_id, 'tenant for ' || p_email);
      INSERT INTO policies (tenant_id, doc)
        VALUES (v_new_tenant_id,
          '{"version":1,"spend_caps":{"window":"month","limit_eur":0},"tld_allowlist":[],"tld_denylist":[],"tools":{"list_*":"allow","get_*":"allow","check_domain":"allow","register_domain":"confirm","update_domain":"confirm","delete_contact":"confirm","update_contact":"confirm","create_contact":"allow"},"ip_allowlist":[]}'::jsonb);
      RETURN QUERY
        INSERT INTO users (tenant_id, email, password_hash, role)
        VALUES (v_new_tenant_id, p_email, p_password_hash, 'owner')
        RETURNING 'created'::text, users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      IF EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(p_email) AND u.status <> 'deleted') THEN
        RETURN QUERY SELECT 'email_taken'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN;
      END IF;
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION signup_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_tenant(text, text) TO app_role;

CREATE FUNCTION find_user_by_email(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role text, status text, password_hash text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT id, tenant_id, role, status, password_hash
    FROM users
   WHERE lower(email) = lower(p_email) AND status <> 'deleted'
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_by_email(text) TO app_role;

DROP FUNCTION IF EXISTS accept_invitation(text, text, text);

CREATE FUNCTION accept_invitation(p_token text, p_password_hash text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text, email text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_inv invitations%ROWTYPE; v_uid uuid;
BEGIN
  SELECT * INTO v_inv FROM invitations WHERE token = p_token;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_token'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN; END IF;
  IF v_inv.accepted_at IS NOT NULL THEN RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN; END IF;
  IF v_inv.expires_at <= now() THEN RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(v_inv.email) AND u.status <> 'deleted') THEN
    RETURN QUERY SELECT 'email_taken'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id AND accepted_at IS NULL;
  IF NOT FOUND THEN RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN; END IF;
  INSERT INTO users (tenant_id, email, password_hash, role)
    VALUES (v_inv.tenant_id, v_inv.email, p_password_hash, v_inv.role)
    RETURNING id INTO v_uid;
  RETURN QUERY SELECT 'accepted'::text, v_inv.tenant_id, v_uid, v_inv.role, v_inv.email;
END;
$$;
REVOKE ALL ON FUNCTION accept_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invitation(text, text) TO app_role;

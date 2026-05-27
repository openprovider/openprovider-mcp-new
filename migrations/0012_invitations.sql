CREATE TABLE invitations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  email              text NOT NULL,
  role               text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  token              text NOT NULL,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  accepted_at        timestamptz
);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY invitations_isolation ON invitations
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO app_role;

CREATE UNIQUE INDEX invitations_pending_email ON invitations (tenant_id, email) WHERE accepted_at IS NULL;
CREATE UNIQUE INDEX invitations_token ON invitations (token);

DROP FUNCTION IF EXISTS resolve_or_provision_tenant(text, text);

CREATE FUNCTION resolve_or_provision_tenant(p_subject text, p_email text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_new_tenant_id uuid;
BEGIN
  LOOP
    -- Branch 1: existing user resolves to their tenant.
    RETURN QUERY
      SELECT 'resolved'::text, u.tenant_id, u.id, u.role FROM users u WHERE u.oauth_subject = p_subject;
    IF FOUND THEN
      RETURN;
    END IF;

    -- Branch 2: a pending, non-expired invite for this email → signal accept, do NOT provision.
    IF EXISTS (
      SELECT 1 FROM invitations i
       WHERE lower(i.email) = lower(p_email)
         AND i.accepted_at IS NULL
         AND i.expires_at > now()
    ) THEN
      RETURN QUERY SELECT 'pending_invite'::text, NULL::uuid, NULL::uuid, NULL::text;
      RETURN;
    END IF;

    -- Branch 3: provision a fresh tenant + owner user.
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
        RETURNING 'resolved'::text, users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- lost the race; subtransaction (incl. tenants + policies) rolled back. Loop.
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION resolve_or_provision_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_provision_tenant(text, text) TO app_role;

CREATE FUNCTION accept_invitation(p_token text, p_subject text, p_email text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_inv invitations%ROWTYPE;
  v_uid uuid;
BEGIN
  -- A subject already mapped to a user belongs to exactly one tenant; reject.
  IF EXISTS (SELECT 1 FROM users u WHERE u.oauth_subject = p_subject) THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_inv FROM invitations WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_token'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF lower(v_inv.email) <> lower(p_email) THEN
    RETURN QUERY SELECT 'email_mismatch'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Atomically claim: only one concurrent caller flips accepted_at.
  UPDATE invitations SET accepted_at = now()
    WHERE id = v_inv.id AND accepted_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  INSERT INTO users (tenant_id, email, oauth_subject, role)
    VALUES (v_inv.tenant_id, NULLIF(p_email, ''), p_subject, v_inv.role)
    RETURNING id INTO v_uid;

  RETURN QUERY SELECT 'accepted'::text, v_inv.tenant_id, v_uid, v_inv.role;
END;
$$;

REVOKE ALL ON FUNCTION accept_invitation(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invitation(text, text, text) TO app_role;

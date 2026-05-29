CREATE OR REPLACE FUNCTION signup_tenant(p_email text, p_password_hash text)
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
          '{"version":1,"spend_caps":{"window":"month","limit_eur":0},"tld_allowlist":[],"tld_denylist":[],"tools":{"list_*":"allow","get_*":"allow","check_*":"allow","suggest_*":"allow","check_domain":"allow","register_domain":"confirm","update_domain":"confirm","delete_contact":"confirm","update_contact":"confirm","create_contact":"allow","reset_domain_authcode":"allow","approve_domain_transfer":"allow","send_foa1_domain_transfer":"allow","delete_domain":"confirm","restart_domain_operation":"confirm","renew_domain":"confirm","transfer_domain":"confirm","trade_domain":"confirm","restore_domain":"confirm"},"ip_allowlist":[]}'::jsonb);
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

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
          '{"version":1,"spend_caps":{"window":"month","limit_eur":0},"tld_allowlist":[],"tld_denylist":[],"tools":{"list_*":"allow","get_*":"allow","check_*":"allow","suggest_*":"allow","check_domain":"allow","register_domain":"confirm","update_domain":"confirm","delete_contact":"confirm","update_contact":"confirm","create_contact":"allow","reset_domain_authcode":"allow","approve_domain_transfer":"allow","send_foa1_domain_transfer":"allow","delete_domain":"confirm","restart_domain_operation":"confirm","renew_domain":"confirm","transfer_domain":"confirm","trade_domain":"confirm","restore_domain":"confirm","create_dns_zone":"allow","update_dns_zone":"allow","delete_dns_zone":"confirm","create_nameserver":"allow","update_nameserver":"allow","delete_nameserver":"confirm","create_ns_group":"allow","update_ns_group":"allow","delete_ns_group":"confirm","create_dns_template":"allow","delete_dns_template":"confirm","create_domain_token":"allow","create_tag":"allow","delete_tag":"confirm","create_ssl_order":"confirm","renew_ssl_order":"confirm","reissue_ssl_order":"confirm","cancel_ssl_order":"confirm","update_ssl_order":"allow","update_ssl_approver_email":"allow","resend_ssl_approver_email":"allow","create_csr":"allow","decode_csr":"allow","create_ssl_otp_token":"allow","create_customer":"allow","update_customer":"allow","delete_customer":"confirm","create_email_template":"allow","update_email_template":"allow","delete_email_template":"confirm","start_email_verification":"allow","restart_email_verification":"allow","create_dmarc":"allow","retry_dmarc":"allow","dmarc_sso_login":"allow","delete_dmarc":"confirm","spam_experts_login_url":"allow","create_spam_experts_domain":"allow","update_spam_experts_domain":"allow","delete_spam_experts_domain":"confirm"},"ip_allowlist":[]}'::jsonb);
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

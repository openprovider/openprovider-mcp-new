CREATE FUNCTION resolve_or_provision_tenant(p_subject text, p_email text)
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
      RETURN QUERY
        INSERT INTO users (tenant_id, email, oauth_subject, role)
        VALUES (v_new_tenant_id, NULLIF(p_email, ''), p_subject, 'owner')
        RETURNING users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- lost the race; subtransaction (incl. tenants insert) rolled back. Loop.
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION resolve_or_provision_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_provision_tenant(text, text) TO app_role;

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

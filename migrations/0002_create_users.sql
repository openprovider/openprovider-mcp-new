CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  email           text NOT NULL,
  oauth_subject   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  UNIQUE (tenant_id, email),
  UNIQUE (oauth_subject)
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_isolation ON users
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON users TO app_role;

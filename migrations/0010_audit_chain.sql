ALTER TABLE audit_events ADD COLUMN prev_hash bytea;
ALTER TABLE audit_events ADD COLUMN row_hash  bytea;

CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev bytea;
  v_canon text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

  SELECT row_hash INTO v_prev
    FROM audit_events
   WHERE tenant_id = NEW.tenant_id
   ORDER BY id DESC LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev,
    '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);

  v_canon := concat_ws('|',
    NEW.id::text, NEW.occurred_at::text, NEW.tenant_id::text,
    NEW.actor_kind, NEW.actor_subject, NEW.event_type,
    COALESCE(NEW.tool_name,''), COALESCE(NEW.resource_type,''), COALESCE(NEW.resource_id,''),
    COALESCE(NEW.request_args::text,''), COALESCE(NEW.result::text,''),
    COALESCE(NEW.http_status::text,''), COALESCE(NEW.error_code,''),
    COALESCE(NEW.trace_id,''), COALESCE(NEW.span_id,''));

  NEW.row_hash := digest(NEW.prev_hash || convert_to(v_canon, 'UTF8'), 'sha256');
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_chain_trg BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

CREATE TABLE audit_archives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  period_end    timestamptz NOT NULL,
  object_url    text NOT NULL,
  sha256        text NOT NULL,
  first_id      bigint NOT NULL,
  last_id       bigint NOT NULL,
  last_row_hash bytea NOT NULL,
  sealed_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_archives_isolation ON audit_archives
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT ON audit_archives TO app_role;

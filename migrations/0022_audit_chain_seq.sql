-- Chain audit events by a per-tenant counter assigned UNDER the advisory lock,
-- not by the bigserial id (whose nextval is assigned before the BEFORE-INSERT
-- trigger acquires the lock, so id-order can diverge from chain-order under
-- concurrency and "break" the verified chain). See Phase-8 item 1.
ALTER TABLE audit_events ADD COLUMN chain_seq bigint;

-- Backfill any pre-existing rows in id order per tenant (defensive; no prod data yet).
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY id) AS rn
    FROM audit_events
)
UPDATE audit_events e SET chain_seq = o.rn FROM ordered o WHERE e.id = o.id;

CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev bytea;
  v_prev_seq bigint;
  v_canon text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

  SELECT row_hash, chain_seq INTO v_prev, v_prev_seq
    FROM audit_events
   WHERE tenant_id = NEW.tenant_id
   ORDER BY chain_seq DESC NULLS LAST
   LIMIT 1;

  NEW.chain_seq := COALESCE(v_prev_seq, 0) + 1;
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

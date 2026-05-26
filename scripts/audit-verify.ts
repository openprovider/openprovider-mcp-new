import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { GENESIS, auditRowCanonical, chainHash } from '../src/audit/chain.js';

export interface VerifyResult {
  ok: boolean;
  rows: number;
  brokenAtId?: string;
}

export async function verifyTenantChain(
  pool: import('pg').Pool,
  tenantId: string,
): Promise<VerifyResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);

    const r = await client.query<{
      id: string;
      occurred_at: string;
      tenant_id: string;
      actor_kind: string;
      actor_subject: string;
      event_type: string;
      tool_name: string | null;
      resource_type: string | null;
      resource_id: string | null;
      request_args_text: string | null;
      result_text: string | null;
      http_status: string | null;
      error_code: string | null;
      trace_id: string | null;
      span_id: string | null;
      prev_hash: Buffer;
      row_hash: Buffer;
    }>(
      `SELECT id::text AS id, occurred_at::text AS occurred_at, tenant_id::text AS tenant_id,
              actor_kind, actor_subject, event_type, tool_name,
              resource_type, resource_id,
              request_args::text AS request_args_text,
              result::text AS result_text,
              http_status::text AS http_status,
              error_code, trace_id, span_id,
              prev_hash, row_hash
         FROM audit_events WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );

    await client.query('COMMIT');

    let expectedPrev = GENESIS;
    for (const row of r.rows) {
      if (!row.prev_hash.equals(expectedPrev)) {
        return { ok: false, rows: r.rows.length, brokenAtId: row.id };
      }
      const canon = auditRowCanonical({
        id: row.id,
        occurredAt: row.occurred_at,
        tenantId: row.tenant_id,
        actorKind: row.actor_kind,
        actorSubject: row.actor_subject,
        eventType: row.event_type,
        toolName: row.tool_name,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        requestArgsText: row.request_args_text,
        resultText: row.result_text,
        httpStatus: row.http_status,
        errorCode: row.error_code,
        traceId: row.trace_id,
        spanId: row.span_id,
      });
      const recomputed = chainHash(row.prev_hash, canon);
      if (!recomputed.equals(row.row_hash)) {
        return { ok: false, rows: r.rows.length, brokenAtId: row.id };
      }
      expectedPrev = row.row_hash;
    }
    return { ok: true, rows: r.rows.length };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { tenant: { type: 'string' } } });
  if (!values.tenant) {
    console.error('Usage: audit:verify --tenant <uuid>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  try {
    const res = await verifyTenantChain(pool, values.tenant);
    if (res.ok) {
      console.error(`OK (${res.rows} rows)`);
    } else {
      console.error(`audit.chain.broken at id=${res.brokenAtId}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run main() when invoked as a script, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('audit-verify.ts')) {
  void main();
}

import 'dotenv/config';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { createDb } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createGcsObjectStore, type ObjectStore } from '../src/audit/object-store.js';

export async function sealTenant(
  pool: pg.Pool,
  store: ObjectStore,
  tenantId: string,
  before: Date,
): Promise<{ sealed: number; objectUrl?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);

    // Watermark: the highest last_id already sealed (or 0 if none).
    const watermark = await client.query<{ last_id: string }>(
      `SELECT COALESCE(MAX(last_id),0)::text AS last_id FROM audit_archives WHERE tenant_id=$1`,
      [tenantId],
    );
    const fromId = BigInt(watermark.rows[0]!.last_id);

    const rows = await client.query<Record<string, unknown>>(
      `SELECT id, occurred_at, tenant_id, actor_kind, actor_subject, event_type, tool_name,
              resource_type, resource_id, request_args, result, http_status, error_code,
              trace_id, span_id,
              encode(prev_hash,'hex') AS prev_hash,
              encode(row_hash,'hex')  AS row_hash
         FROM audit_events
        WHERE tenant_id=$1 AND occurred_at < $2 AND id > $3
        ORDER BY id`,
      [tenantId, before, fromId.toString()],
    );

    if (rows.rows.length === 0) {
      await client.query('COMMIT');
      return { sealed: 0 };
    }

    const ndjson = rows.rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const gz = gzipSync(Buffer.from(ndjson, 'utf8'));
    const sha = createHash('sha256').update(gz).digest('hex');
    const firstId = String(rows.rows[0]!['id']);
    const lastId = String(rows.rows[rows.rows.length - 1]!['id']);
    const lastRowHashHex = rows.rows[rows.rows.length - 1]!['row_hash'] as string;
    const key = `audit/${tenantId}/${before.toISOString().slice(0, 10)}.ndjson.gz`;
    const url = await store.put(key, gz, 'application/gzip');

    await client.query(
      `INSERT INTO audit_archives (tenant_id, period_end, object_url, sha256, first_id, last_id, last_row_hash)
       VALUES ($1,$2,$3,$4,$5,$6, decode($7,'hex'))`,
      [tenantId, before, url, sha, firstId, lastId, lastRowHashHex],
    );
    await client.query('COMMIT');
    return { sealed: rows.rows.length, objectUrl: url };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { before: { type: 'string' }, tenant: { type: 'string' } },
  });
  if (!values.before || !values.tenant) {
    console.error('Usage: audit:seal --before YYYY-MM-DD --tenant <uuid>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const store = createGcsObjectStore({ bucket: cfg.gcsBucket });
  try {
    const res = await sealTenant(pool, store, values.tenant, new Date(values.before));
    console.error(`Sealed ${res.sealed} rows${res.objectUrl ? ' → ' + res.objectUrl : ''}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('audit-seal.ts')) {
  void main();
}

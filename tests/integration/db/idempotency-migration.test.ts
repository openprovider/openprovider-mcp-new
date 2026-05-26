import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';

const T = '00000000-0000-0000-0000-0000000000e1';

describe('migration 0009 idempotency_records', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]);
    } finally {
      c.release();
    }
  }, 60_000);
  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('inserts + reads a record under RLS', async () => {
    await runAsTenant(pool, T, async (c) => {
      await c.query(
        `INSERT INTO idempotency_records (tenant_id, key, tool_name, result_json, expires_at)
         VALUES ($1,'k1','create_contact','{"handle":"X"}'::jsonb, now() + interval '10 min')`,
        [T],
      );
      const r = await c.query<{ result_json: { handle: string } }>(
        `SELECT result_json FROM idempotency_records WHERE key='k1'`,
      );
      expect(r.rows[0]?.result_json.handle).toBe('X');
    });
  });
});

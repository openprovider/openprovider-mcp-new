import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';

const T = '00000000-0000-0000-0000-00000000aa01';

describe('migration 0011 api_keys + resolve_api_key', () => {
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
    await runAsTenant(pool, T, async (c) => {
      await c.query(
        `INSERT INTO api_keys (tenant_id, prefix, hash, name, scopes)
         VALUES ($1,'op_live_abcd','$argon2id$hash','k1', ARRAY['mcp:read'])`,
        [T],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('resolve_api_key returns the candidate by prefix (cross-tenant, app_role)', async () => {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string; scopes: string[] }>(
        'SELECT * FROM resolve_api_key($1)',
        ['op_live_abcd'],
      );
      expect(r.rows[0]?.tenant_id).toBe(T);
      expect(r.rows[0]?.scopes).toEqual(['mcp:read']);
    } finally {
      c.release();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

describe('RLS — tenants table', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO tenants (id, name) VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`,
        [TENANT_A, TENANT_B],
      );
    } finally {
      client.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('returns only the calling tenant when RLS is set', async () => {
    const rowsA = await runAsTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ id: string }>('SELECT id FROM tenants');
      return r.rows;
    });
    expect(rowsA.map((r) => r.id)).toEqual([TENANT_A]);
  });

  it('cannot UPDATE another tenant via RLS', async () => {
    await expect(
      runAsTenant(pool, TENANT_A, async (c) => {
        const r = await c.query('UPDATE tenants SET name = $1 WHERE id = $2', ['hijacked', TENANT_B]);
        return r.rowCount;
      }),
    ).resolves.toBe(0);
  });
});

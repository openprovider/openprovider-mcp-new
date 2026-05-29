import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';

describe('migration 0021 auditor role', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    pool = (await migratedDb(fixture.url)).pool;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await fixture?.stop();
  });

  it('users.role accepts auditor and rejects a bogus role', async () => {
    const t = '00000000-0000-0000-0000-0000000000a1';
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'x') ON CONFLICT DO NOTHING`, [t]);
      await expect(
        c.query(`INSERT INTO users (tenant_id,email,role) VALUES ($1,'auditor@x.io','auditor')`, [
          t,
        ]),
      ).resolves.toBeTruthy();
      await expect(
        c.query(`INSERT INTO users (tenant_id,email,role) VALUES ($1,'bogus@x.io','bogus')`, [t]),
      ).rejects.toThrow();
    } finally {
      c.release();
    }
  });
});

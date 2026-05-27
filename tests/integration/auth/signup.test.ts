import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner } from '../_helpers/db.js';

describe('signup_tenant', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => { fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool; }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  it('provisions tenant + owner + default policy + password_hash', async () => {
    const r = await seedTenantOwner(pool, 'su-owner@example.com', 'hash-1');
    expect(r.status).toBe('created');
    expect(r.role).toBe('owner');
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const pol = await c.query(`SELECT 1 FROM policies WHERE tenant_id=$1`, [r.tenant_id]);
      expect(pol.rowCount).toBe(1);
      const u = await c.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [r.user_id]);
      expect(u.rows[0]!.password_hash).toBe('hash-1');
    } finally { c.release(); }
  });

  it('rejects a duplicate active email with email_taken', async () => {
    await seedTenantOwner(pool, 'dup@example.com', 'h');
    const again = await seedTenantOwner(pool, 'DUP@example.com', 'h2'); // case-insensitive
    expect(again.status).toBe('email_taken');
  });
});

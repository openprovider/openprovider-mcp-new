import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner } from '../_helpers/db.js';

describe('signup_tenant', () => {
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

  it('provisions tenant + owner + default policy + password_hash', async () => {
    const r = await seedTenantOwner(pool, 'su-owner@example.com', 'hash-1');
    expect(r.status).toBe('created');
    expect(r.role).toBe('owner');
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const pol = await c.query(`SELECT 1 FROM policies WHERE tenant_id=$1`, [r.tenant_id]);
      expect(pol.rowCount).toBe(1);
      const u = await c.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id=$1`,
        [r.user_id],
      );
      expect(u.rows[0]!.password_hash).toBe('hash-1');
    } finally {
      c.release();
    }
  });

  it('rejects a duplicate active email with email_taken', async () => {
    await seedTenantOwner(pool, 'dup@example.com', 'h');
    const again = await seedTenantOwner(pool, 'DUP@example.com', 'h2'); // case-insensitive
    expect(again.status).toBe('email_taken');
  });

  async function findByEmail(email: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query('SELECT * FROM find_user_by_email($1)', [email]);
      return r.rows[0];
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }
  it('find_user_by_email returns the row + hash for an active user (case-insensitive)', async () => {
    const s = await seedTenantOwner(pool, 'find-me@example.com', 'the-hash');
    const u = await findByEmail('FIND-ME@example.com');
    expect(u.user_id).toBe(s.user_id);
    expect(u.tenant_id).toBe(s.tenant_id);
    expect(u.role).toBe('owner');
    expect(u.password_hash).toBe('the-hash');
  });
  it('find_user_by_email returns nothing for an unknown email', async () => {
    expect(await findByEmail('ghost@example.com')).toBeUndefined();
  });
});

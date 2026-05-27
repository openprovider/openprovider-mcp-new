import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner, runAsTenant } from '../_helpers/db.js';

describe('consume_password_reset', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let tenantId: string;
  let userId: string;
  beforeAll(async () => {
    fixture = await startPostgres();
    pool = (await migratedDb(fixture.url)).pool;
    const s = await seedTenantOwner(pool, 'pr-owner@example.com', 'old-hash');
    tenantId = s.tenant_id;
    userId = s.user_id;
    await runAsTenant(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO password_resets (tenant_id,user_id,token,expires_at) VALUES ($1,$2,'pr-tok', now()+interval '1 hour')`,
        [tenantId, userId],
      );
    });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await fixture?.stop();
  });

  async function consume(token: string, hash: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query('SELECT * FROM consume_password_reset($1,$2)', [token, hash]);
      return r.rows[0]!;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }
  it('ok sets the new password hash and is single-use', async () => {
    const r = await consume('pr-tok', 'new-hash');
    expect(r.status).toBe('ok');
    expect(r.user_id).toBe(userId);
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const u = await c.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id=$1`,
        [userId],
      );
      expect(u.rows[0]!.password_hash).toBe('new-hash');
    } finally {
      c.release();
    }
    expect((await consume('pr-tok', 'x')).status).toBe('already_used');
  });
  it('rejects unknown / expired', async () => {
    expect((await consume('nope', 'x')).status).toBe('invalid_token');
    await runAsTenant(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO password_resets (tenant_id,user_id,token,expires_at) VALUES ($1,$2,'pr-exp', now()-interval '1 minute')`,
        [tenantId, userId],
      );
    });
    expect((await consume('pr-exp', 'x')).status).toBe('expired');
  });
});

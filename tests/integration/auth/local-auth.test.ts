import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { signup, findUserByEmail, consumePasswordReset } from '../../../src/auth/local-auth.js';

describe('local-auth wrappers', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => { fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool; }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  it('signup creates a tenant+owner; duplicate → email_taken', async () => {
    const a = await signup(pool, 'la@example.com', 'hashA');
    expect(a.status).toBe('created');
    expect((await signup(pool, 'la@example.com', 'hashB')).status).toBe('email_taken');
  });
  it('findUserByEmail returns the row+hash; null for unknown', async () => {
    await signup(pool, 'finder@example.com', 'theHash');
    const u = await findUserByEmail(pool, 'finder@example.com');
    expect(u?.role).toBe('owner'); expect(u?.passwordHash).toBe('theHash');
    expect(await findUserByEmail(pool, 'nobody@example.com')).toBeNull();
  });
  it('consumePasswordReset sets the new hash', async () => {
    const s = await signup(pool, 'reset@example.com', 'origHash');
    if (s.status !== 'created') throw new Error('expected created');
    await runAsTenant(pool, s.tenantId, async (c) => { await c.query(
      `INSERT INTO password_resets (tenant_id,user_id,token,expires_at) VALUES ($1,$2,'la-tok', now()+interval '1 hour')`,
      [s.tenantId, s.userId]); });
    const r = await consumePasswordReset(pool, 'la-tok', 'newHash');
    expect(r.status).toBe('ok');
  });
});

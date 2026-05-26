import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';

async function resolve(pool: pg.Pool, subject: string, email: string) {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ tenant_id: string; user_id: string; role: string }>(
      'SELECT * FROM resolve_or_provision_tenant($1, $2)',
      [subject, email],
    );
    return r.rows[0];
  } finally {
    c.release();
  }
}

describe('resolve_or_provision_tenant', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('provisions a tenant + owner user on first call', async () => {
    const res = await resolve(pool, 'sub_first', 'first@example.com');
    expect(res?.tenant_id).toBeTruthy();
    expect(res?.user_id).toBeTruthy();
    expect(res?.role).toBe('owner');
  });

  it('is idempotent: same subject returns the same tenant + user', async () => {
    const a = await resolve(pool, 'sub_idem', 'idem@example.com');
    const b = await resolve(pool, 'sub_idem', 'idem@example.com');
    expect(b?.tenant_id).toBe(a?.tenant_id);
    expect(b?.user_id).toBe(a?.user_id);
  });

  it('handles concurrent first-logins with one tenant and zero orphans', async () => {
    const subject = 'sub_race';
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolve(pool, subject, 'race@example.com')),
    );
    const tenantIds = new Set(results.map((r) => r?.tenant_id));
    expect(tenantIds.size).toBe(1);

    // No orphan tenants: every tenant for this subject's user must have a user row.
    const c = await pool.connect();
    try {
      const orphans = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM tenants t
          WHERE t.name = 'tenant for ' || $1
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id)`,
        [subject],
      );
      expect(orphans.rows[0]?.count).toBe('0');
    } finally {
      c.release();
    }
  });

  it('keeps RLS enforced for normal app_role queries (function is the only cross-tenant path)', async () => {
    // Provision two tenants.
    const a = await resolve(pool, 'sub_rls_a', 'a@example.com');
    await resolve(pool, 'sub_rls_b', 'b@example.com');
    // As app_role with tenant A context, only A's user is visible.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_role');
      await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', a!.tenant_id]);
      const rows = await c.query<{ oauth_subject: string }>('SELECT oauth_subject FROM users');
      expect(rows.rows.every((x) => x.oauth_subject === 'sub_rls_a')).toBe(true);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});

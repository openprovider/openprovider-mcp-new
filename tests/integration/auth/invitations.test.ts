import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';

describe('migration 0012 invitations', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['inv_owner_sub', 'owner@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('inserts a pending invite scoped to the tenant under RLS', async () => {
    const id = await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'invitee@example.com', 'operator', 'tok-1', now() + interval '7 days')
         RETURNING id`,
        [tenantId],
      );
      return r.rows[0]!.id;
    });
    expect(id).toBeTruthy();
  });

  it('enforces the partial unique index: two pending invites for one email collide', async () => {
    await expect(
      runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
           VALUES ($1, 'invitee@example.com', 'viewer', 'tok-2', now() + interval '7 days')`,
          [tenantId],
        );
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('rejects role=owner via the CHECK constraint', async () => {
    await expect(
      runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
           VALUES ($1, 'owner2@example.com', 'owner', 'tok-3', now() + interval '7 days')`,
          [tenantId],
        );
      }),
    ).rejects.toThrow(/check|constraint/i);
  });

  it('allows two different tenants to each hold a pending invite for the same email', async () => {
    const c = await pool.connect();
    let tenant2: string;
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['inv_owner2_sub', 'owner2@example.com'],
      );
      tenant2 = r.rows[0]!.tenant_id;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
    const id = await runAsTenant(pool, tenant2, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'invitee@example.com', 'viewer', 'tok-t2', now() + interval '7 days')
         RETURNING id`,
        [tenant2],
      );
      return r.rows[0]!.id;
    });
    expect(id).toBeTruthy();
  });

  async function resolve(subject: string, email: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ status: string; tenant_id: string | null; role: string | null }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        [subject, email],
      );
      return r.rows[0]!;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }

  it('resolve returns status=resolved + role=owner when provisioning a brand-new subject', async () => {
    const res = await resolve('inv_fresh_sub', 'fresh@example.com');
    expect(res.status).toBe('resolved');
    expect(res.tenant_id).toBeTruthy();
    expect(res.role).toBe('owner');
    const pc = await pool.connect();
    try {
      await pc.query('RESET ROLE');
      const pr = await pc.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM policies WHERE tenant_id = $1`,
        [res.tenant_id],
      );
      expect(pr.rows[0]!.count).toBe('1');
    } finally {
      pc.release();
    }
  });

  it('resolve returns pending_invite (no provision) when a pending invite matches the email', async () => {
    // tenantId already has a pending invite for invitee@example.com (first test in this file).
    const res = await resolve('invitee_new_sub', 'invitee@example.com');
    expect(res.status).toBe('pending_invite');
    expect(res.tenant_id).toBeNull();

    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE oauth_subject = $1`,
        ['invitee_new_sub'],
      );
      expect(r.rows[0]!.count).toBe('0');
    } finally {
      c.release();
    }
  });

  it('resolve still resolves an existing user even if a pending invite exists for their email', async () => {
    const res = await resolve('inv_owner_sub', 'owner@example.com');
    expect(res.status).toBe('resolved');
    expect(res.role).toBe('owner');
  });
});

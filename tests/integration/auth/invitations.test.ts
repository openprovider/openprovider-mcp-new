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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await fixture?.stop();
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

  async function accept(token: string, subject: string, email: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ status: string; tenant_id: string | null; role: string | null }>(
        'SELECT * FROM accept_invitation($1,$2,$3)',
        [token, subject, email],
      );
      return r.rows[0]!;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }

  it('accept joins the invited tenant with the invited role (token tok-1 / invitee@example.com)', async () => {
    const res = await accept('tok-1', 'invitee_accept_sub', 'invitee@example.com');
    expect(res.status).toBe('accepted');
    expect(res.tenant_id).toBe(tenantId);
    expect(res.role).toBe('operator');
  });

  it('accept rejects a second use of the same token as already_accepted', async () => {
    const res = await accept('tok-1', 'someone_else_sub', 'invitee@example.com');
    expect(res.status).toBe('already_accepted');
  });

  it('accept rejects an unknown token', async () => {
    const res = await accept('does-not-exist', 'x_sub', 'x@example.com');
    expect(res.status).toBe('invalid_token');
  });

  it('accept rejects when the verified email does not match the invite', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'mismatch@example.com', 'viewer', 'tok-mismatch', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const res = await accept('tok-mismatch', 'mismatch_sub', 'attacker@example.com');
    expect(res.status).toBe('email_mismatch');
  });

  it('accept rejects an expired invite', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'expired@example.com', 'viewer', 'tok-expired', now() - interval '1 hour')`,
        [tenantId],
      );
    });
    const res = await accept('tok-expired', 'expired_sub', 'expired@example.com');
    expect(res.status).toBe('expired');
  });

  it('accept rejects a subject that is already a user (already_member)', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'dup@example.com', 'viewer', 'tok-dup', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const res = await accept('tok-dup', 'inv_owner_sub', 'dup@example.com');
    expect(res.status).toBe('already_member');
  });

  it('concurrent accept of one token creates exactly one user', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'race@example.com', 'viewer', 'tok-race', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const results = await Promise.all([
      accept('tok-race', 'race_sub', 'race@example.com'),
      accept('tok-race', 'race_sub', 'race@example.com'),
    ]);
    const accepted = results.filter((r) => r.status === 'accepted');
    expect(accepted).toHaveLength(1);
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE oauth_subject = 'race_sub'`,
      );
      expect(r.rows[0]!.count).toBe('1');
    } finally {
      c.release();
    }
  });

  it('concurrent accept of one token by two different subjects creates exactly one user', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'race2@example.com', 'viewer', 'tok-race2', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const results = await Promise.all([
      accept('tok-race2', 'race2_sub_a', 'race2@example.com'),
      accept('tok-race2', 'race2_sub_b', 'race2@example.com'),
    ]);
    const accepted = results.filter((r) => r.status === 'accepted');
    expect(accepted).toHaveLength(1);
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE oauth_subject IN ('race2_sub_a','race2_sub_b')`,
      );
      expect(r.rows[0]!.count).toBe('1');
    } finally {
      c.release();
    }
  });

  async function emailHasUserSql(email: string): Promise<boolean> {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ email_has_user: boolean }>('SELECT email_has_user($1)', [email]);
      return r.rows[0]!.email_has_user;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }

  it('email_has_user is true for an existing user (cross-tenant, case-insensitive)', async () => {
    expect(await emailHasUserSql('OWNER@example.com')).toBe(true);
  });

  it('email_has_user is false for an unknown email', async () => {
    expect(await emailHasUserSql('nobody@example.com')).toBe(false);
  });

  it('email_has_user is true for a disabled (not deleted) user', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO users (tenant_id, email, oauth_subject, role, status)
         VALUES ($1, 'disabled-user@example.com', 'ehu_disabled_sub', 'viewer', 'disabled')`,
        [tenantId],
      );
    });
    expect(await emailHasUserSql('disabled-user@example.com')).toBe(true);
  });

  it('email_has_user is false for a soft-deleted user (so a removed user can be re-invited)', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO users (tenant_id, email, oauth_subject, role, status)
         VALUES ($1, 'deleted-user@example.com', 'ehu_deleted_sub', 'viewer', 'deleted')`,
        [tenantId],
      );
    });
    expect(await emailHasUserSql('deleted-user@example.com')).toBe(false);
  });
});

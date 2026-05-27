import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant, seedTenantOwner } from '../_helpers/db.js';

describe('migration 0012 invitations', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const seed = await seedTenantOwner(pool);
    tenantId = seed.tenant_id;
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

  async function accept(token: string, passwordHash: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query('SELECT * FROM accept_invitation($1, $2)', [token, passwordHash]);
      return r.rows[0]!;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }

  it('accept creates the user with the invite email+role+password, and returns the email', async () => {
    // the first test inserts a pending invite for invitee@example.com / role operator / token tok-1 under tenantId
    const res = await accept('tok-1', 'invitee-hash');
    expect(res.status).toBe('accepted');
    expect(res.tenant_id).toBe(tenantId);
    expect(res.role).toBe('operator');
    expect(res.email).toBe('invitee@example.com');
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const u = await c.query<{ email: string; password_hash: string }>(
        `SELECT email, password_hash FROM users WHERE id=$1`,
        [res.user_id],
      );
      expect(u.rows[0]!.email).toBe('invitee@example.com');
      expect(u.rows[0]!.password_hash).toBe('invitee-hash');
    } finally {
      c.release();
    }
  });

  it('accept rejects reuse → already_accepted', async () => {
    expect((await accept('tok-1', 'h')).status).toBe('already_accepted');
  });

  it('accept rejects unknown token → invalid_token', async () => {
    expect((await accept('nope', 'h')).status).toBe('invalid_token');
  });

  it('accept rejects expired', async () => {
    await runAsTenant(pool, tenantId, async (cl) => {
      await cl.query(
        `INSERT INTO invitations (tenant_id,email,role,token,expires_at) VALUES ($1,'exp@example.com','viewer','tok-exp', now()-interval '1 hour')`,
        [tenantId],
      );
    });
    expect((await accept('tok-exp', 'h')).status).toBe('expired');
  });

  it('accept rejects an email already taken → email_taken', async () => {
    // owner@test.local is the email seeded by seedTenantOwner
    await runAsTenant(pool, tenantId, async (cl) => {
      await cl.query(
        `INSERT INTO invitations (tenant_id,email,role,token,expires_at) VALUES ($1,'owner@test.local','viewer','tok-taken', now()+interval '7 days')`,
        [tenantId],
      );
    });
    expect((await accept('tok-taken', 'h')).status).toBe('email_taken');
  });

  it('concurrent accept of one token creates exactly one user', async () => {
    await runAsTenant(pool, tenantId, async (cl) => {
      await cl.query(
        `INSERT INTO invitations (tenant_id,email,role,token,expires_at) VALUES ($1,'race@example.com','viewer','tok-race', now()+interval '7 days')`,
        [tenantId],
      );
    });
    const rs = await Promise.all([accept('tok-race', 'h'), accept('tok-race', 'h')]);
    expect(rs.filter((r) => r.status === 'accepted')).toHaveLength(1);
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
    expect(await emailHasUserSql('OWNER@test.local')).toBe(true);
  });

  it('email_has_user is false for an unknown email', async () => {
    expect(await emailHasUserSql('nobody@example.com')).toBe(false);
  });

  it('email_has_user is true for a disabled (not deleted) user', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO users (tenant_id, email, role, status)
         VALUES ($1, 'disabled-user@example.com', 'viewer', 'disabled')`,
        [tenantId],
      );
    });
    expect(await emailHasUserSql('disabled-user@example.com')).toBe(true);
  });

  it('email_has_user is false for a soft-deleted user (so a removed user can be re-invited)', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO users (tenant_id, email, role, status)
         VALUES ($1, 'deleted-user@example.com', 'viewer', 'deleted')`,
        [tenantId],
      );
    });
    expect(await emailHasUserSql('deleted-user@example.com')).toBe(false);
  });
});

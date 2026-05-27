import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sign } from '@fastify/cookie';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerUsers } from '../../../src/dashboard/routes/users.js';
import { registerAccept } from '../../../src/dashboard/routes/accept.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

const SECRET = 'users-page-secret-32-characters!!';
const CSRF = 'users-csrf-fixed';

function cookie(s: DashboardSession): string {
  return `op_dash=${sign(JSON.stringify(s), SECRET)}`;
}

describe('dashboard users page', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let ownerUserId: string;

  function ownerSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
    return { tenantId, userId: ownerUserId, subject: 'users_owner', role: 'owner', csrf: CSRF, email: 'users-owner@example.com', ...overrides };
  }

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string; user_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['users_owner', 'users-owner@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
      ownerUserId = r.rows[0]!.user_id;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }

    app = Fastify();
    await registerDashboard(app, {
      cookieSecret: SECRET,
      buildAuthorizationUrl: () => 'https://auth.example.com/login',
      authenticateWithCode: async () => ({ userId: ownerUserId, email: 'users-owner@example.com', subject: 'users_owner' }),
      resolveTenant: async () => ({ status: 'resolved' as const, tenantId, userId: ownerUserId, role: 'owner' as const }),
      registerPages: (pageApp) => {
        registerUsers(pageApp, { pool });
        registerAccept(pageApp, { pool });
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await fixture?.stop();
  });

  it('GET /dashboard/users renders the owner in the member list', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/users', headers: { cookie: cookie(ownerSession()) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Team');
    expect(res.body).toContain('users-owner@example.com');
    expect(res.body).toContain('owner');
    expect(res.body).toContain('_csrf');
  });

  it('POST invite with bad CSRF → 403', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dashboard/users/invite',
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: '_csrf=WRONG&email=teammate@example.com&role=operator',
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST invite creates a pending invite and shows the accept link once', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dashboard/users/invite',
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&email=teammate@example.com&role=operator`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/dashboard/accept?token=');
    expect(res.body).toContain('teammate@example.com');

    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(
        `SELECT role FROM invitations WHERE email = 'teammate@example.com' AND accepted_at IS NULL`,
      );
      expect(r.rows[0]!.role).toBe('operator');
    });
  });

  it('POST invite for an email that is already a user is rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dashboard/users/invite',
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&email=users-owner@example.com&role=viewer`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/already (a )?member|already belongs|already a user/i);
  });

  it('a viewer is 403 on GET /dashboard/users', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/users', headers: { cookie: cookie(ownerSession({ role: 'viewer' })) } });
    expect(res.statusCode).toBe(403);
  });

  it('POST invite for an email that already has a pending invite → friendly duplicate error', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dashboard/users/invite',
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&email=teammate@example.com&role=viewer`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/already a pending invitation/i);
  });

  // Helper: create + accept an invite to materialise a member with a known role.
  async function seedMember(email: string, role: 'admin' | 'operator' | 'viewer', subject: string) {
    const token = `seed-${subject}`;
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '7 days')`,
        [tenantId, email, role, token],
      );
    });
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ user_id: string }>(
        'SELECT * FROM accept_invitation($1,$2,$3)',
        [token, subject, email],
      );
      return r.rows[0]!.user_id;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  }

  it('change-role: owner promotes an operator to admin', async () => {
    const uid = await seedMember('promote@example.com', 'operator', 'promote_sub');
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${uid}/role`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&role=admin`,
    });
    expect(res.statusCode).toBe(200);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [uid]);
      expect(r.rows[0]!.role).toBe('admin');
    });
  });

  it('change-role: an admin cannot modify an owner (403)', async () => {
    const adminId = await seedMember('admin1@example.com', 'admin', 'admin1_sub');
    const adminSession = ownerSession({ role: 'admin', userId: adminId, subject: 'admin1_sub', email: 'admin1@example.com' });
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${ownerUserId}/role`,
      headers: { cookie: cookie(adminSession), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&role=viewer`,
    });
    expect(res.statusCode).toBe(403);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [ownerUserId]);
      expect(r.rows[0]!.role).toBe('owner');
    });
  });

  it('change-role: demoting the last owner is rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${ownerUserId}/role`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&role=admin`,
    });
    expect(res.statusCode).toBe(400);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [ownerUserId]);
      expect(r.rows[0]!.role).toBe('owner');
    });
  });

  it('remove: soft-deletes the user and revokes their API keys', async () => {
    const uid = await seedMember('removeme@example.com', 'operator', 'removeme_sub');
    let keyId = '';
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, prefix, hash, name, created_by_user_id)
         VALUES ($1, 'op_live_rm00', 'x', 'rm-key', $2) RETURNING id`,
        [tenantId, uid],
      );
      keyId = r.rows[0]!.id;
    });
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${uid}/remove`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}`,
    });
    expect(res.statusCode).toBe(200);
    await runAsTenant(pool, tenantId, async (client) => {
      const u = await client.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [uid]);
      expect(u.rows[0]!.status).toBe('deleted');
      const k = await client.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM api_keys WHERE id = $1`, [keyId]);
      expect(k.rows[0]!.revoked_at).not.toBeNull();
    });
  });

  it('remove: removing the last owner is rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${ownerUserId}/remove`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}`,
    });
    expect(res.statusCode).toBe(400);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [ownerUserId]);
      expect(r.rows[0]!.status).toBe('active');
    });
  });

  it('change-role: an admin may demote a peer admin (lateral management allowed)', async () => {
    const peerId = await seedMember('peeradmin@example.com', 'admin', 'peeradmin_sub');
    const actorId = await seedMember('actoradmin@example.com', 'admin', 'actoradmin_sub');
    const actorSession = ownerSession({ role: 'admin', userId: actorId, subject: 'actoradmin_sub', email: 'actoradmin@example.com' });
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${peerId}/role`,
      headers: { cookie: cookie(actorSession), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&role=operator`,
    });
    expect(res.statusCode).toBe(200);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [peerId]);
      expect(r.rows[0]!.role).toBe('operator');
    });
  });

  it('revoke pending invite: deletes the row', async () => {
    let inviteId = '';
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'revokeinv@example.com', 'viewer', 'revoke-tok', now() + interval '7 days') RETURNING id`,
        [tenantId],
      );
      inviteId = r.rows[0]!.id;
    });
    const res = await app.inject({
      method: 'POST', url: `/dashboard/invitations/${inviteId}/revoke`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}`,
    });
    expect(res.statusCode).toBe(200);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM invitations WHERE id = $1`,
        [inviteId],
      );
      expect(r.rows[0]!.count).toBe('0');
    });
  });
});

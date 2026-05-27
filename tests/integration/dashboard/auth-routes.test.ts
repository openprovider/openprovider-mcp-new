/**
 * Integration tests for:
 *   GET/POST /dashboard/accept       (set-password, public)
 *   GET/POST /dashboard/reset        (password reset, public)
 *   POST     /dashboard/account/password  (change-password, session-guarded)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sign } from '@fastify/cookie';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant, seedTenantOwner } from '../_helpers/db.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerAccept } from '../../../src/dashboard/routes/accept.js';
import { registerAuthRoutes } from '../../../src/dashboard/routes/auth.js';
import { registerOverview } from '../../../src/dashboard/routes/overview.js';
import { hashPassword, verifyPassword } from '../../../src/auth/password.js';
import { findUserByEmail } from '../../../src/auth/local-auth.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

const COOKIE_SECRET = 'auth-routes-test-secret-32chars!!';
const COOKIE_NAME = 'op_dash';
const CSRF_TOKEN = 'auth-routes-csrf-fixed';

function makeSessionCookie(session: DashboardSession): string {
  const value = JSON.stringify(session);
  return `${COOKIE_NAME}=${sign(value, COOKIE_SECRET)}`;
}

describe('auth-routes integration', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    app = Fastify();
    await registerDashboard(app, {
      cookieSecret: COOKIE_SECRET,
      signup: async () => ({ status: 'email_taken' as const }),
      login: async () => ({ ok: false as const }),
      registerPages: (pageApp) => {
        registerAccept(pageApp, { pool });
        registerAuthRoutes(pageApp, { pool });
        registerOverview(pageApp, { pool });
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await pgFixture?.stop();
  });

  // ===========================================================================
  // Accept (set-password) — public flow
  // ===========================================================================

  describe('GET /dashboard/accept', () => {
    it('renders the set-password form with the token pre-filled', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/accept?token=some-token-abc',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Set your password');
      expect(res.body).toContain('some-token-abc');
    });
  });

  describe('POST /dashboard/accept', () => {
    it('short password → 400 with error message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/accept',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'token=tok&password=short',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('12 characters');
    });

    it('invalid token → 400 with error message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/accept',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'token=bad-token-xyz&password=validpassword123',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('not valid');
    });

    it('valid token + valid password → 302 to /dashboard + Set-Cookie + user created', async () => {
      // Seed a tenant owner to get a tenant_id
      const owner = await seedTenantOwner(pool, 'accept-owner@test.local');
      const tenantId = owner.tenant_id;

      // Insert an invitation row for a new invitee
      const inviteEmail = 'invitee@test.local';
      const token = 'accept-test-token-' + Date.now();
      await runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
           VALUES ($1, $2, 'viewer', $3, now() + interval '1 day')`,
          [tenantId, inviteEmail, token],
        );
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/accept',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `token=${token}&password=validpassword123`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/dashboard');
      expect(res.headers['set-cookie']).toBeDefined();

      // Verify the user now exists with a password_hash
      const user = await findUserByEmail(pool, inviteEmail);
      expect(user).not.toBeNull();
      expect(user!.passwordHash).not.toBeNull();
      expect(await verifyPassword(user!.passwordHash!, 'validpassword123')).toBe(true);
    });
  });

  // ===========================================================================
  // Reset password — public flow
  // ===========================================================================

  describe('GET /dashboard/reset', () => {
    it('renders the reset form with token pre-filled', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/reset?token=reset-tok-123',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Reset password');
      expect(res.body).toContain('reset-tok-123');
    });
  });

  describe('POST /dashboard/reset', () => {
    it('short password → 400 with error message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/reset',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'token=tok&password=short',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('12 characters');
    });

    it('invalid token → 400 with error message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/reset',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'token=bad-token-nope&password=newpassword1234',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('not valid');
    });

    it('valid token → 200 renders login with notice, password_hash updated', async () => {
      // Seed owner with a known password
      const ownerEmail = 'reset-owner@test.local';
      const originalPw = 'original-password-123';
      const owner = await seedTenantOwner(pool, ownerEmail, await hashPassword(originalPw));
      const tenantId = owner.tenant_id;
      const userId = owner.user_id;

      // Insert a password_resets row
      const token = 'reset-test-token-' + Date.now();
      await runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO password_resets (tenant_id, user_id, token, expires_at)
           VALUES ($1, $2, $3, now() + interval '1 hour')`,
          [tenantId, userId, token],
        );
      });

      const newPw = 'brand-new-password-456';
      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/reset',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `token=${token}&password=${newPw}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Sign in');
      expect(res.body).toContain('Password updated');

      // Verify the password_hash was updated
      const user = await findUserByEmail(pool, ownerEmail);
      expect(user).not.toBeNull();
      expect(user!.passwordHash).not.toBeNull();
      expect(await verifyPassword(user!.passwordHash!, newPw)).toBe(true);
      expect(await verifyPassword(user!.passwordHash!, originalPw)).toBe(false);
    });
  });

  // ===========================================================================
  // Change password — session-guarded + CSRF
  // ===========================================================================

  describe('POST /dashboard/account/password', () => {
    it('no session → redirect to /dashboard/login', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/account/password',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '_csrf=x&current=old&next=newpassword1234',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/dashboard/login');
    });

    it('bad CSRF → 403', async () => {
      const ownerEmail = 'changepw-csrf@test.local';
      const currentPw = 'current-password-987';
      const owner = await seedTenantOwner(pool, ownerEmail, await hashPassword(currentPw));

      const session: DashboardSession = {
        tenantId: owner.tenant_id,
        userId: owner.user_id,
        subject: ownerEmail,
        role: 'owner',
        csrf: CSRF_TOKEN,
        email: ownerEmail,
      };

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/account/password',
        headers: {
          cookie: makeSessionCookie(session),
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=WRONGTOKEN&current=${currentPw}&next=newpassword1234`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('wrong current password → 400', async () => {
      const ownerEmail = 'changepw-wrong@test.local';
      const currentPw = 'current-password-abc';
      const owner = await seedTenantOwner(pool, ownerEmail, await hashPassword(currentPw));

      const session: DashboardSession = {
        tenantId: owner.tenant_id,
        userId: owner.user_id,
        subject: ownerEmail,
        role: 'owner',
        csrf: CSRF_TOKEN,
        email: ownerEmail,
      };

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/account/password',
        headers: {
          cookie: makeSessionCookie(session),
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=${CSRF_TOKEN}&current=WRONGPASSWORD123&next=newpassword5678`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('incorrect');
    });

    it('correct current password + valid new password → 302 to /dashboard, hash updated', async () => {
      const ownerEmail = 'changepw-ok@test.local';
      const currentPw = 'current-password-xyz';
      const newPw = 'new-secure-password-789';
      const owner = await seedTenantOwner(pool, ownerEmail, await hashPassword(currentPw));

      const session: DashboardSession = {
        tenantId: owner.tenant_id,
        userId: owner.user_id,
        subject: ownerEmail,
        role: 'owner',
        csrf: CSRF_TOKEN,
        email: ownerEmail,
      };

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/account/password',
        headers: {
          cookie: makeSessionCookie(session),
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=${CSRF_TOKEN}&current=${currentPw}&next=${newPw}`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/dashboard');

      // Verify the password was changed in the DB
      const user = await findUserByEmail(pool, ownerEmail);
      expect(user).not.toBeNull();
      expect(user!.passwordHash).not.toBeNull();
      expect(await verifyPassword(user!.passwordHash!, newPw)).toBe(true);
      expect(await verifyPassword(user!.passwordHash!, currentPw)).toBe(false);
    });

    it('new password too short → 400', async () => {
      const ownerEmail = 'changepw-short@test.local';
      const currentPw = 'current-password-lmn';
      const owner = await seedTenantOwner(pool, ownerEmail, await hashPassword(currentPw));

      const session: DashboardSession = {
        tenantId: owner.tenant_id,
        userId: owner.user_id,
        subject: ownerEmail,
        role: 'owner',
        csrf: CSRF_TOKEN,
        email: ownerEmail,
      };

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/account/password',
        headers: {
          cookie: makeSessionCookie(session),
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=${CSRF_TOKEN}&current=${currentPw}&next=short`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('12 characters');
    });
  });
});

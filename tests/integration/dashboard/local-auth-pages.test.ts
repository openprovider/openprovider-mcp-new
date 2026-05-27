/**
 * Integration tests for the local email+password signup/login dashboard routes.
 *
 * Strategy:
 *   - Boot a real Fastify app with registerDashboard + real deps wired to a migratedDb pool
 *   - Use app.inject (no real listen needed)
 *   - Verify Set-Cookie and Location headers for happy paths
 *   - Verify error status codes and body text for failure paths
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { signup, findUserByEmail } from '../../../src/auth/local-auth.js';
import { hashPassword, verifyPassword, assertPasswordPolicy } from '../../../src/auth/password.js';
import type pg from 'pg';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('dashboard local-auth pages integration', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;

  const COOKIE_SECRET = 'test-cookie-secret-local-auth-32ch!';

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    app = Fastify();

    await registerDashboard(app, {
      cookieSecret: COOKIE_SECRET,
      signup: async (email, password) => {
        try {
          assertPasswordPolicy(password);
        } catch {
          return { status: 'invalid_password' as const };
        }
        const r = await signup(pool, email, await hashPassword(password));
        return r.status === 'created'
          ? { status: 'created' as const, tenantId: r.tenantId, userId: r.userId, role: r.role, email }
          : { status: 'email_taken' as const };
      },
      login: async (email, password) => {
        const u = await findUserByEmail(pool, email);
        if (!u || !u.passwordHash || !(await verifyPassword(u.passwordHash, password))) {
          return { ok: false as const };
        }
        return { ok: true as const, tenantId: u.tenantId, userId: u.userId, role: u.role, email };
      },
      registerPages: () => {},
    });

    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await pgFixture.stop();
  });

  // =========================================================================
  // Signup — happy path
  // =========================================================================

  it('POST /dashboard/signup with valid email + strong password → 302 to /dashboard with cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/signup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=newuser%40example.com&password=StrongPassword123',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  // =========================================================================
  // Signup — duplicate email
  // =========================================================================

  it('POST /dashboard/signup with same email again → 409 + "already in use"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/signup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=newuser%40example.com&password=StrongPassword123',
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('already in use');
  });

  // =========================================================================
  // Signup — short password
  // =========================================================================

  it('POST /dashboard/signup with short password → 400 + policy error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/signup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=short%40example.com&password=tooshort',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('12 characters');
  });

  // =========================================================================
  // Login — happy path
  // =========================================================================

  it('POST /dashboard/login with correct password → 302 to /dashboard', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=newuser%40example.com&password=StrongPassword123',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  // =========================================================================
  // Login — wrong password
  // =========================================================================

  it('POST /dashboard/login with wrong password → 401 + "Invalid email or password"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=newuser%40example.com&password=WrongPassword999',
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid email or password');
  });
});

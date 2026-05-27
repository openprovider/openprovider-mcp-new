/**
 * Integration tests for the three core dashboard pages:
 *   GET/POST /dashboard/openprovider
 *   GET/POST  /dashboard/policy
 *   GET       /dashboard
 *
 * Strategy:
 *   - Boot a real Fastify app with registerDashboard (+ the three page routes)
 *   - Use app.inject (no real listen needed)
 *   - Sign a DashboardSession cookie with the test cookie secret so requireSession accepts it
 *   - Include the matching csrf token in form POSTs
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sign } from '@fastify/cookie';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createFakeKms } from '../../../src/secrets/fake-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerOverview } from '../../../src/dashboard/routes/overview.js';
import { registerOpenprovider } from '../../../src/dashboard/routes/openprovider.js';
import { registerPolicy } from '../../../src/dashboard/routes/policy.js';
import { getPolicy } from '../../../src/policies/repo.js';
import { DEFAULT_POLICY } from '../../../src/policies/schema.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars!!';
const COOKIE_NAME = 'op_dash';
const TENANT = '00000000-0000-0000-0000-00000000cc01';
const USER_ID = '00000000-0000-0000-0000-00000000cc02';
const CSRF_TOKEN = 'test-csrf-token-fixed';

// ---------------------------------------------------------------------------
// Helper: build a signed op_dash cookie carrying the given session
// ---------------------------------------------------------------------------

function makeSessionCookie(session: DashboardSession): string {
  const value = JSON.stringify(session);
  // sign() from @fastify/cookie produces "value.signature"
  return `${COOKIE_NAME}=${sign(value, COOKIE_SECRET)}`;
}

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    tenantId: TENANT,
    userId: USER_ID,
    subject: 'test-subject',
    role: 'owner',
    csrf: CSRF_TOKEN,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('dashboard pages-core integration', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const kms = createFakeKms();
  const kmsKeyName = 'fake-key';

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    // Seed tenant
    const seedClient = await pool.connect();
    try {
      await seedClient.query(`INSERT INTO tenants (id, name) VALUES ($1, 'test-tenant')`, [TENANT]);
      await seedClient.query(
        `INSERT INTO users (tenant_id, email, oauth_subject, role) VALUES ($1, 'test@example.com', 'test-subject', 'owner')`,
        [TENANT],
      );
    } finally {
      seedClient.release();
    }

    // Build the Fastify app with the dashboard registered
    app = Fastify();

    await registerDashboard(app, {
      cookieSecret: COOKIE_SECRET,
      signup: async () => ({ status: 'email_taken' as const }),
      login: async () => ({ ok: false as const }),
      registerPages: (pageApp) => {
        registerOverview(pageApp, { pool });
        registerOpenprovider(pageApp, { pool, kms, kmsKeyName });
        registerPolicy(pageApp, { pool });
      },
    });

    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await pgFixture.stop();
  });

  // -------------------------------------------------------------------------
  // requireSession guard — without a session cookie → redirect to /dashboard/login
  // -------------------------------------------------------------------------

  it('GET /dashboard/openprovider without session → redirect to /dashboard/login', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/openprovider',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('GET /dashboard/policy without session → redirect to /dashboard/login', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/policy',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('GET /dashboard without session → redirect to /dashboard/login', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  // -------------------------------------------------------------------------
  // GET /dashboard/openprovider with valid session → 200 + form
  // -------------------------------------------------------------------------

  it('GET /dashboard/openprovider with valid session → 200 renders form', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/openprovider',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Openprovider');
    // CSRF hidden input must be present
    expect(res.body).toContain(`name="_csrf"`);
    expect(res.body).toContain(CSRF_TOKEN);
    // Password field must be blank (never pre-filled)
    expect(res.body).toContain('type="password"');
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/openprovider — CSRF rejection
  // -------------------------------------------------------------------------

  it('POST /dashboard/openprovider with bad CSRF → 403, no DB change', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/openprovider',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=WRONG_TOKEN&username=user%40example.com&password=secret123',
    });
    expect(res.statusCode).toBe(403);

    // DB must be unchanged — no openprovider_accounts row
    const rows = await runAsTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ username: string }>(
        `SELECT username FROM openprovider_accounts WHERE tenant_id = $1`,
        [TENANT],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('POST /dashboard/openprovider with missing CSRF field → 403', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/openprovider',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'username=user%40example.com&password=secret123',
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/openprovider — valid CSRF → persists creds
  // -------------------------------------------------------------------------

  it('POST /dashboard/openprovider with valid CSRF → persists creds, redirect ?ok=1', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/openprovider',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${CSRF_TOKEN}&username=op-user%40example.com&password=supersecret`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/openprovider?ok=1');

    // openprovider_accounts row exists with status=connected
    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ username: string; status: string }>(
        `SELECT username, status FROM openprovider_accounts WHERE tenant_id = $1`,
        [TENANT],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.username).toBe('op-user@example.com');
      expect(r.rows[0]!.status).toBe('connected');
    });

    // tenant_secrets has the encrypted password; decrypt it and verify it matches
    await runAsTenant(pool, TENANT, async (client) => {
      const store = createSecretsStore({
        kms,
        kmsKeyArn: kmsKeyName,
        repo: createDbSecretsRepo(client),
      });
      const plaintext = await store.get(TENANT, 'openprovider.password');
      expect(plaintext).not.toBeNull();
      expect(plaintext!.toString('utf8')).toBe('supersecret');
    });
  });

  // -------------------------------------------------------------------------
  // GET /dashboard — overview page
  // -------------------------------------------------------------------------

  it('GET /dashboard with valid session → 200 renders overview', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Overview');
    // Shows account status
    expect(res.body).toMatch(/connected|not connected/i);
  });

  // -------------------------------------------------------------------------
  // GET /dashboard/policy
  // -------------------------------------------------------------------------

  it('GET /dashboard/policy with valid session → 200 renders policy textarea', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/policy',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('policy');
    expect(res.body).toContain(`name="_csrf"`);
    expect(res.body).toContain(CSRF_TOKEN);
    // Textarea with policy content
    expect(res.body).toContain('spend_caps');
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/policy — CSRF rejection
  // -------------------------------------------------------------------------

  it('POST /dashboard/policy with bad CSRF → 403', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/policy',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=BADTOKEN&policy=${encodeURIComponent(JSON.stringify(DEFAULT_POLICY))}`,
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/policy — invalid JSON → 200 with error, stored policy unchanged
  // -------------------------------------------------------------------------

  it('POST /dashboard/policy with invalid JSON → 200, body contains error, stored policy unchanged', async () => {
    const session = makeSession();

    // First, get the current policy so we can verify it doesn't change
    const policyBefore = await runAsTenant(pool, TENANT, async (c) => getPolicy(c, TENANT));

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/policy',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${CSRF_TOKEN}&policy=${encodeURIComponent('{ this is not valid json }')}`,
    });

    expect(res.statusCode).toBe(200);
    // Body must contain an error message
    expect(res.body.toLowerCase()).toMatch(/error|invalid/i);
    // The submitted bad text should be re-rendered in the textarea
    expect(res.body).toContain('this is not valid json');

    // Stored policy must be unchanged
    const policyAfter = await runAsTenant(pool, TENANT, async (c) => getPolicy(c, TENANT));
    expect(JSON.stringify(policyAfter)).toBe(JSON.stringify(policyBefore));
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/policy — invalid schema (valid JSON, fails Zod) → 200 with error
  // -------------------------------------------------------------------------

  it('POST /dashboard/policy with valid JSON but invalid schema → 200, error shown', async () => {
    const session = makeSession();
    const badPolicy = { version: 1, spend_caps: { window: 'week', limit_eur: 100 } };

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/policy',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${CSRF_TOKEN}&policy=${encodeURIComponent(JSON.stringify(badPolicy))}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toMatch(/error|validation/i);
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/policy — valid policy → round-trips (getPolicy reflects it)
  // -------------------------------------------------------------------------

  it('POST /dashboard/policy with valid policy → redirect ?ok=1, getPolicy reflects update', async () => {
    const session = makeSession();
    const newPolicy = {
      ...DEFAULT_POLICY,
      spend_caps: { window: 'month' as const, limit_eur: 42 },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/policy',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${CSRF_TOKEN}&policy=${encodeURIComponent(JSON.stringify(newPolicy))}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/policy?ok=1');

    // getPolicy must now reflect the new limit
    const stored = await runAsTenant(pool, TENANT, async (c) => getPolicy(c, TENANT));
    expect(stored.spend_caps.limit_eur).toBe(42);
  });
});

/**
 * Integration tests for the three management dashboard pages:
 *   GET/POST /dashboard/keys        (API key list/issue/revoke)
 *   GET      /dashboard/audit       (audit log viewer + NDJSON export)
 *   GET/POST /dashboard/confirmations (pending list + approve)
 *
 * Strategy:
 *   - Boot a real Fastify app with registerDashboard + all page routes
 *   - Use app.inject (no real listen needed)
 *   - Sign a DashboardSession cookie with the test cookie secret
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
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerOverview } from '../../../src/dashboard/routes/overview.js';
import { registerOpenprovider } from '../../../src/dashboard/routes/openprovider.js';
import { registerPolicy } from '../../../src/dashboard/routes/policy.js';
import { registerKeys } from '../../../src/dashboard/routes/keys.js';
import { registerAudit } from '../../../src/dashboard/routes/audit.js';
import { registerConfirmations } from '../../../src/dashboard/routes/confirmations.js';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';
import { proposeConfirmation } from '../../../src/policies/repo.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_SECRET = 'test-cookie-secret-manage-pages-32ch!';
const COOKIE_NAME = 'op_dash';
const TENANT = '00000000-0000-0000-0000-00000000dd01';
const USER_ID = '00000000-0000-0000-0000-00000000dd02';
const CSRF_TOKEN = 'manage-csrf-token-fixed';
const FAKE_TOOL = 'check_domain'; // non-billable, always prices at 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionCookie(session: DashboardSession): string {
  const value = JSON.stringify(session);
  return `${COOKIE_NAME}=${sign(value, COOKIE_SECRET)}`;
}

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    tenantId: TENANT,
    userId: USER_ID,
    subject: 'test-subject-manage',
    role: 'owner',
    csrf: CSRF_TOKEN,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('dashboard pages-manage integration', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const kms = createFakeKms();
  const kmsKeyName = 'fake-key';
  const openproviderClient = createOpenproviderClient();

  // Mutable state set during seeding
  let issuedKeyId = '';
  let issuedKeyPrefix = '';
  let pendingConfirmationId = '';

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    // Seed tenant + user
    const seedClient = await pool.connect();
    try {
      await seedClient.query(`INSERT INTO tenants (id, name) VALUES ($1, 'manage-tenant')`, [
        TENANT,
      ]);
      await seedClient.query(
        `INSERT INTO users (tenant_id, email, oauth_subject, role)
         VALUES ($1, 'manage@example.com', 'test-subject-manage', 'owner')`,
        [TENANT],
      );
    } finally {
      seedClient.release();
    }

    // Seed audit_events and a pending confirmation under RLS context
    await runAsTenant(pool, TENANT, async (client) => {
      // Audit rows
      await client.query(
        `INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type, tool_name)
         VALUES ($1, 'user', 'test-subject-manage', 'tool_call', 'check_domain'),
                ($1, 'user', 'test-subject-manage', 'tool_call', 'list_domains')`,
        [TENANT],
      );

      // Policy row for liveSpendCents
      await client.query(
        `INSERT INTO policies (tenant_id, doc) VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [
          TENANT,
          JSON.stringify({
            version: 1,
            spend_caps: { window: 'month', limit_eur: 1000 },
            tool_overrides: {},
          }),
        ],
      );

      // Pending confirmation
      const args = { domain: 'example.com' };
      const rec = await proposeConfirmation({
        client,
        tenantId: TENANT,
        principalSubject: 'test-subject-manage',
        toolName: FAKE_TOOL,
        args,
        summaryText: `${FAKE_TOOL} (est. €0.00)`,
        estimatedCostCents: 0,
        requiredApproverRoles: ['owner'],
        ttlMs: 10 * 60 * 1000,
      });
      pendingConfirmationId = rec.id;
    });

    // Build the Fastify app with all pages registered
    app = Fastify();

    await registerDashboard(app, {
      cookieSecret: COOKIE_SECRET,
      signup: async () => ({ status: 'email_taken' as const }),
      login: async () => ({ ok: false as const }),
      registerPages: (pageApp) => {
        registerOverview(pageApp, { pool });
        registerOpenprovider(pageApp, { pool, kms, kmsKeyName });
        registerPolicy(pageApp, { pool });
        registerKeys(pageApp, { pool });
        registerAudit(pageApp, { pool });
        registerConfirmations(pageApp, { pool, kms, kmsKeyName, openproviderClient });
      },
    });

    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await pgFixture.stop();
  });

  // =========================================================================
  // API Keys — GET /dashboard/keys
  // =========================================================================

  it('GET /dashboard/keys without session → redirect to /dashboard/login', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/keys' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('GET /dashboard/keys with valid session → 200 renders key list', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/keys',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('API Keys');
    expect(res.body).toContain('_csrf');
    expect(res.body).toContain(CSRF_TOKEN);
  });

  // =========================================================================
  // API Keys — POST /dashboard/keys/issue CSRF rejection
  // =========================================================================

  it('POST /dashboard/keys/issue with bad CSRF → 403', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/keys/issue',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=WRONGTOKEN&name=TestKey',
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /dashboard/keys/issue with missing CSRF → 403', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/keys/issue',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'name=TestKey',
    });
    expect(res.statusCode).toBe(403);
  });

  // =========================================================================
  // API Keys — POST /dashboard/keys/issue — happy path
  // =========================================================================

  it('POST /dashboard/keys/issue with valid CSRF → response shows op_live_ key ONCE', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/keys/issue',
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${CSRF_TOKEN}&name=MyIntegrationKey`,
    });

    expect(res.statusCode).toBe(200);
    // Plaintext key must appear in the response
    expect(res.body).toMatch(/op_live_/);
    // "copy now" style message
    expect(res.body).toMatch(/copy|again|shown/i);

    // Extract the key from the response to verify prefix in list
    const keyMatch = res.body.match(/op_live_[A-Za-z0-9_-]+/);
    expect(keyMatch).not.toBeNull();
    const fullKey = keyMatch![0]!;
    issuedKeyPrefix = fullKey.slice(0, 12);

    // Verify it's in the DB
    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ id: string; prefix: string; name: string }>(
        `SELECT id, prefix, name FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [TENANT],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.prefix).toBe(issuedKeyPrefix);
      expect(r.rows[0]!.name).toBe('MyIntegrationKey');
      issuedKeyId = r.rows[0]!.id;
    });
  });

  // =========================================================================
  // API Keys — GET list shows prefix of issued key
  // =========================================================================

  it('GET /dashboard/keys shows the prefix of the issued key', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/keys',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(issuedKeyPrefix);
    expect(res.body).toContain('active');
  });

  // =========================================================================
  // API Keys — POST /dashboard/keys/:id/revoke CSRF rejection
  // =========================================================================

  it('POST /dashboard/keys/:id/revoke with bad CSRF → 403', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: `/dashboard/keys/${issuedKeyId}/revoke`,
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=BADTOKEN',
    });
    expect(res.statusCode).toBe(403);
    // Verify key is still active
    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_keys WHERE id = $1`,
        [issuedKeyId],
      );
      expect(r.rows[0]!.revoked_at).toBeNull();
    });
  });

  // =========================================================================
  // API Keys — POST /dashboard/keys/:id/revoke — happy path
  // =========================================================================

  it('POST /dashboard/keys/:id/revoke with valid CSRF → status flips to revoked', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: `/dashboard/keys/${issuedKeyId}/revoke`,
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${CSRF_TOKEN}`,
    });
    expect(res.statusCode).toBe(200);
    // Response re-renders the list with 'revoked' status
    expect(res.body).toContain('revoked');

    // DB must reflect revocation
    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_keys WHERE id = $1`,
        [issuedKeyId],
      );
      expect(r.rows[0]!.revoked_at).not.toBeNull();
    });
  });

  // =========================================================================
  // Audit — GET /dashboard/audit
  // =========================================================================

  it('GET /dashboard/audit without session → redirect to /dashboard/login', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/audit' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('GET /dashboard/audit with valid session → 200 renders seeded rows tenant-scoped', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/audit',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Audit');
    // Seeded tool names must appear
    expect(res.body).toContain('check_domain');
    expect(res.body).toContain('list_domains');
    // actor subject
    expect(res.body).toContain('test-subject-manage');
  });

  it('GET /dashboard/audit with tool filter returns only matching rows', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/audit?tool=check_domain',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('check_domain');
    // Only 1 matching row so total=1
    expect(res.body).toMatch(/Showing 1/);
  });

  // =========================================================================
  // Audit — GET /dashboard/audit/export
  // =========================================================================

  it('GET /dashboard/audit/export without session → redirect to /dashboard/login', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/audit/export' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('GET /dashboard/audit/export → NDJSON attachment with tenant rows', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/audit/export',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(`audit-${TENANT}.ndjson`);

    // Each line must be valid JSON containing audit fields
    const body = res.body.trim();
    expect(body.length).toBeGreaterThan(0);
    const lines = body.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2); // at least 2 seeded rows
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toHaveProperty('event_type');
      expect(parsed).toHaveProperty('actor_subject');
    }
  });

  // =========================================================================
  // Confirmations — GET /dashboard/confirmations
  // =========================================================================

  it('GET /dashboard/confirmations without session → redirect to /dashboard/login', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/confirmations' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('GET /dashboard/confirmations with valid session → 200 renders page', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/confirmations',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Confirmation');
    expect(res.body).toContain('_csrf');
  });

  it('GET /dashboard/confirmations shows the seeded pending confirmation', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/confirmations',
      headers: { cookie: makeSessionCookie(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(pendingConfirmationId);
    expect(res.body).toContain(FAKE_TOOL);
  });

  // =========================================================================
  // Confirmations — CSRF rejection on approve
  // =========================================================================

  it('POST /dashboard/confirmations/:id/approve with bad CSRF → 403', async () => {
    const session = makeSession();
    const res = await app.inject({
      method: 'POST',
      url: `/dashboard/confirmations/${pendingConfirmationId}/approve`,
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=WRONG',
    });
    expect(res.statusCode).toBe(403);

    // Confirmation must still be unconsumed
    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM confirmations WHERE id = $1`,
        [pendingConfirmationId],
      );
      expect(r.rows[0]!.consumed_at).toBeNull();
    });
  });

  // =========================================================================
  // Confirmations — approve drives the consume path
  // =========================================================================

  it('POST /dashboard/confirmations/:id/approve with valid CSRF → consume path runs', async () => {
    const session = makeSession();

    // Seed a fresh confirmation for the approve test (the pendingConfirmationId is preserved
    // for the list test above)
    let freshId!: string;
    await runAsTenant(pool, TENANT, async (client) => {
      const args = { domain: 'approve-test.com' };
      const rec = await proposeConfirmation({
        client,
        tenantId: TENANT,
        principalSubject: 'test-subject-manage',
        toolName: FAKE_TOOL,
        args,
        summaryText: `${FAKE_TOOL} (est. €0.00)`,
        estimatedCostCents: 0,
        requiredApproverRoles: ['owner'],
        ttlMs: 10 * 60 * 1000,
      });
      freshId = rec.id;
    });

    const res = await app.inject({
      method: 'POST',
      url: `/dashboard/confirmations/${freshId}/approve`,
      headers: {
        cookie: makeSessionCookie(session),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${CSRF_TOKEN}`,
    });

    // Route always returns 200 (re-renders the page with approveResult)
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Confirmation');

    // Verify reservation was settled — no longer 'pending'
    // (no OP account connected → consume errors → reservation released)
    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ status: string }>(
        `SELECT status FROM spend_reservations WHERE confirmation_id = $1`,
        [freshId],
      );
      expect(r.rows[0]?.status).not.toBe('pending');
    });
  });
});

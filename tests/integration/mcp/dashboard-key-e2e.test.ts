/**
 * Phase 6 marquee e2e: dashboard issue-key → authenticate /mcp → revoke → 401
 *
 * Strategy:
 *   1. Boot a single Fastify app with both /mcp (apiKeyResolver) and /dashboard routes.
 *   2. Sign a DashboardSession cookie the same way pages-manage.test.ts does.
 *   3. POST /dashboard/keys/issue → extract op_live_ plaintext from HTML response.
 *   4. Nock Openprovider login + domains/check; call /mcp tools/call check_domain
 *      with Authorization: Bearer <that key> → assert success.
 *   5. POST /dashboard/keys/:id/revoke with CSRF.
 *   6. Call /mcp again with the same key → assert 401.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { sign } from '@fastify/cookie';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createFakeKms } from '../../../src/secrets/fake-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import { createApiKeyResolver } from '../../../src/auth/api-key.js';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';
import { createOpenproviderTokenManager } from '../../../src/openprovider/token-manager.js';
import { createPgTokenCache } from '../../../src/openprovider/token-cache-pg.js';
import { OpenproviderAccountNotConnected } from '../../../src/openprovider/errors.js';
import { createCheckDomainTool } from '../../../src/tools/check-domain.js';
import { createDispatcher } from '../../../src/mcp/dispatch.js';
import { createPgAuditSink } from '../../../src/audit/pg-sink.js';
import { createMcpServer } from '../../../src/mcp/transport.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerOverview } from '../../../src/dashboard/routes/overview.js';
import { registerOpenprovider } from '../../../src/dashboard/routes/openprovider.js';
import { registerPolicy } from '../../../src/dashboard/routes/policy.js';
import { registerKeys } from '../../../src/dashboard/routes/keys.js';
import { registerAudit } from '../../../src/dashboard/routes/audit.js';
import { registerConfirmations } from '../../../src/dashboard/routes/confirmations.js';
import type { Principal } from '../../../src/auth/principal.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_SECRET = 'test-cookie-secret-e2e-dk-32chars!!';
const COOKIE_NAME = 'op_dash';
const CSRF_TOKEN = 'e2e-dk-csrf-token-fixed';

// ---------------------------------------------------------------------------
// Cookie helper (mirrors pages-manage.test.ts)
// ---------------------------------------------------------------------------

function makeSessionCookie(session: DashboardSession): string {
  const value = JSON.stringify(session);
  return `${COOKIE_NAME}=${sign(value, COOKIE_SECRET)}`;
}

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    tenantId: '',
    userId: '',
    subject: 'e2e-dk-subject',
    role: 'owner',
    csrf: CSRF_TOKEN,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('phase 6 e2e: dashboard issue-key → authenticate /mcp → revoke → 401', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let baseUrl: string;

  // Provisioned in beforeAll
  let tenantId: string;
  let userId: string;

  const kms = createFakeKms();
  const kmsKeyName = 'fake-key';

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    // Provision tenant + user via SECURITY DEFINER (avoids direct INSERT into tenants).
    const seedClient = await pool.connect();
    try {
      await seedClient.query('SET ROLE app_role');
      const tenantRow = await seedClient.query<{ tenant_id: string }>(
        `SELECT * FROM resolve_or_provision_tenant($1, $2)`,
        ['e2e_dk_sub', 'e2e-dk@example.com'],
      );
      tenantId = tenantRow.rows[0]!.tenant_id;
    } finally {
      seedClient.release();
    }

    // Seed user row so the session subject resolves correctly.
    const userSeed = await pool.connect();
    try {
      const r = await userSeed.query<{ id: string }>(
        `SELECT id FROM users WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      userId = r.rows[0]?.id ?? '00000000-0000-0000-0000-000000000001';
    } finally {
      userSeed.release();
    }

    // Seed Openprovider account + encrypted password under RLS context.
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO openprovider_accounts (tenant_id, username)
         VALUES ($1, 'op-e2e-dk')
         ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username`,
        [tenantId],
      );
      const store = createSecretsStore({
        kms,
        kmsKeyArn: kmsKeyName,
        repo: createDbSecretsRepo(client),
      });
      await store.put(tenantId, 'openprovider.password', Buffer.from('pw-e2e-dk'));
    });

    // Seed policy row (needed by overview page's liveSpendCents query).
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO policies (tenant_id, doc)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [
          tenantId,
          JSON.stringify({
            version: 1,
            spend_caps: { window: 'month', limit_eur: 1000 },
            tool_overrides: {},
          }),
        ],
      );
    });

    // Build apiKeyResolver backed by the real pool.
    const apiKeyResolver = createApiKeyResolver(pool);

    // Build the dispatchFactory (mirrors p6 pattern in e2e.test.ts).
    const openproviderClient = createOpenproviderClient();

    async function dispatchFactory(principal: Principal) {
      const client = await pool.connect();
      let inTx = false;
      try {
        await client.query('BEGIN');
        inTx = true;
        await client.query('SET LOCAL ROLE app_role');
        await client.query('SELECT set_config($1, $2, true)', [
          'app.current_tenant',
          principal.tenantId,
        ]);

        async function fetchCredentials(
          tid: string,
        ): Promise<{ username: string; password: string }> {
          const u = await client.query<{ username: string }>(
            'SELECT username FROM openprovider_accounts WHERE tenant_id = $1',
            [tid],
          );
          const username = u.rows[0]?.username;
          if (!username) throw new OpenproviderAccountNotConnected();
          const store = createSecretsStore({
            kms,
            kmsKeyArn: kmsKeyName,
            repo: createDbSecretsRepo(client),
          });
          const passwordBuf = await store.get(tid, 'openprovider.password');
          if (!passwordBuf) throw new OpenproviderAccountNotConnected();
          return { username, password: passwordBuf.toString('utf8') };
        }

        const tokenManager = createOpenproviderTokenManager({
          fetchCredentials,
          cache: createPgTokenCache({
            client,
            getDek: async (tid) => {
              const r = await client.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
                'SELECT wrapped_dek, kms_key_arn FROM tenant_keys WHERE tenant_id = $1',
                [tid],
              );
              if (!r.rows[0]) throw new Error(`no tenant_keys row for ${tid}`);
              return kms.decrypt(r.rows[0].kms_key_arn, r.rows[0].wrapped_dek);
            },
          }),
        });

        const tools = [createCheckDomainTool({ client: openproviderClient, tokenManager })];
        const dispatch = createDispatcher({ tools, audit: createPgAuditSink(client) });

        return {
          dispatch,
          cleanup: async () => {
            try {
              if (inTx) await client.query('COMMIT');
            } catch {
              try {
                await client.query('ROLLBACK');
              } catch {
                /* ignore */
              }
            } finally {
              inTx = false;
              client.release();
            }
          },
        };
      } catch (err) {
        try {
          if (inTx) await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        client.release();
        throw err;
      }
    }

    // createMcpServer returns a Fastify instance; register the dashboard on the same app.
    app = await createMcpServer({
      devToken: 'never-used-dk-e2e',
      devPrincipal: {
        kind: 'user',
        tenantId: '00000000-0000-0000-0000-000000000000',
        userId: '00000000-0000-0000-0000-000000000000',
        subject: 'dev',
        scopes: [],
        role: 'viewer',
      },
      apiKeyResolver,
      dispatchFactory,
    });

    await registerDashboard(app, {
      cookieSecret: COOKIE_SECRET,
      buildAuthorizationUrl: () => 'https://auth.example.com/login',
      authenticateWithCode: async () => ({
        userId,
        email: 'e2e-dk@example.com',
        subject: 'e2e-dk-subject',
      }),
      resolveTenant: async () => ({
        status: 'resolved' as const,
        tenantId,
        userId,
        role: 'owner' as const,
      }),
      registerPages: (pageApp) => {
        registerOverview(pageApp, { pool });
        registerOpenprovider(pageApp, { pool, kms, kmsKeyName });
        registerPolicy(pageApp, { pool });
        registerKeys(pageApp, { pool });
        registerAudit(pageApp, { pool });
        registerConfirmations(pageApp, { pool, kms, kmsKeyName, openproviderClient });
      },
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 180_000);

  afterAll(async () => {
    nock.cleanAll();
    if (app) await app.close();
    if (pool) await pool.end();
    if (pgFixture) await pgFixture.stop();
  });

  // ---------------------------------------------------------------------------
  // MCP helpers (real HTTP — mirrors e2e.test.ts p6 helpers)
  // ---------------------------------------------------------------------------

  async function mcpInitSession(bearer: string): Promise<{ sid: string; status: number }> {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-dk', version: '0' },
        },
      }),
    });
    const sid = r.headers.get('mcp-session-id') ?? '';
    return { sid, status: r.status };
  }

  async function mcpCallCheckDomain(sid: string, bearer: string): Promise<unknown> {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
        'mcp-session-id': sid,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'check_domain',
          arguments: { domains: [{ name: 'dktest', extension: 'com' }], with_price: false },
        },
      }),
    });
    const text = await r.text();
    const jsonLine = text.includes('data:')
      ? text
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5)
          .trim()
      : text;
    return JSON.parse(jsonLine) as unknown;
  }

  // ---------------------------------------------------------------------------
  // Dashboard helpers (real HTTP — POST with form body + signed cookie)
  // ---------------------------------------------------------------------------

  async function dashboardIssueKey(session: DashboardSession): Promise<Response> {
    return fetch(`${baseUrl}/dashboard/keys/issue`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: makeSessionCookie(session),
      },
      body: `_csrf=${CSRF_TOKEN}&name=E2EDashboardKey`,
      redirect: 'manual',
    });
  }

  async function dashboardRevokeKey(session: DashboardSession, keyId: string): Promise<Response> {
    return fetch(`${baseUrl}/dashboard/keys/${keyId}/revoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: makeSessionCookie(session),
      },
      body: `_csrf=${CSRF_TOKEN}`,
      redirect: 'manual',
    });
  }

  // ---------------------------------------------------------------------------
  // The marquee scenario
  // ---------------------------------------------------------------------------

  it('step 1→5: issue key via dashboard → /mcp auth succeeds → revoke → /mcp returns 401', async () => {
    const session = makeSession({ tenantId, userId });

    // ── Step 1: POST /dashboard/keys/issue ──────────────────────────────────
    const issueRes = await dashboardIssueKey(session);
    expect(issueRes.status, 'issue endpoint should return 200').toBe(200);

    const issueBody = await issueRes.text();
    expect(issueBody, 'issue response must contain op_live_ key').toMatch(/op_live_/);
    expect(issueBody, 'issue response should show copy-now message').toMatch(/copy|again|shown/i);

    // Extract the plaintext key from the HTML response.
    const keyMatch = issueBody.match(/op_live_[A-Za-z0-9_-]+/);
    expect(keyMatch, 'regex must match the plaintext key in the response').not.toBeNull();
    const plaintextKey = keyMatch![0]!;
    const keyPrefix = plaintextKey.slice(0, 12);

    // Extract the key id from the DB (same as pages-manage does).
    let keyId!: string;
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string; prefix: string }>(
        `SELECT id, prefix FROM api_keys WHERE prefix = $1 AND tenant_id = $2 LIMIT 1`,
        [keyPrefix, tenantId],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.prefix).toBe(keyPrefix);
      keyId = r.rows[0]!.id;
    });

    // ── Step 2: Nock Openprovider; call /mcp check_domain with the issued key ─
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .reply(200, { data: { token: 'jwt-dk-e2e', reseller_id: 1 } });
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(200, { data: { results: [{ domain: 'dktest.com', status: 'free' }] } });

    const { sid, status: initStatus } = await mcpInitSession(plaintextKey);
    expect(initStatus, 'initialize with issued key should return 200').toBe(200);
    expect(sid, 'initialize should return an Mcp-Session-Id').toBeTruthy();

    const mcpBody = (await mcpCallCheckDomain(sid, plaintextKey)) as {
      result?: { content: { text: string }[] };
      error?: { message: string };
    };
    const innerText = mcpBody.result?.content[0]?.text;
    expect(
      innerText,
      'check_domain with issued key should succeed, got: ' + JSON.stringify(mcpBody),
    ).toBeDefined();
    const parsed = JSON.parse(innerText ?? '{}') as { results: { domain: string }[] };
    expect(parsed.results[0]?.domain).toBe('dktest.com');

    // ── Step 3: POST /dashboard/keys/:id/revoke ─────────────────────────────
    const revokeRes = await dashboardRevokeKey(session, keyId);
    expect(revokeRes.status, 'revoke endpoint should return 200').toBe(200);

    const revokeBody = await revokeRes.text();
    expect(revokeBody, 'revoke response should show revoked status').toContain('revoked');

    // Verify revocation in the DB.
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_keys WHERE id = $1`,
        [keyId],
      );
      expect(r.rows[0]!.revoked_at, 'revoked_at must be set in the DB').not.toBeNull();
    });

    // ── Step 4: Call /mcp again with the same (now revoked) key → 401 ───────
    const { status: revokedStatus } = await mcpInitSession(plaintextKey);
    expect(revokedStatus, 'revoked key must yield 401 on /mcp').toBe(401);
  }, 120_000);
});

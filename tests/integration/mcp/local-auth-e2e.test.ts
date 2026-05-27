/**
 * Phase 6c marquee e2e: local-auth + cross-actor RBAC over real HTTP.
 *
 * This is the authoritative end-to-end proof of the local-auth flow + the
 * cross-actor RBAC loop (it replaces the deleted WorkOS-based rbac-e2e). There
 * is NO WorkOS anywhere: a person signs up (gets a tenant + owner), issues an
 * API key, invites a teammate who joins by setting a password via a token'd
 * link and can then log in; and the RBAC model holds — an operator (API key)
 * can PROPOSE a write but only an owner/admin can APPROVE (the owner does so
 * via the real dashboard confirmations route).
 *
 * Boots ONE Fastify app with both /mcp (createMcpServer) and the dashboard
 * (registerDashboard). The wiring is modelled on:
 *   - dashboard-key-e2e.test.ts (boot + signed-cookie + issue-key + dispatchFactory)
 *   - e2e.test.ts Phase 5 (register_domain propose/confirm + approver_role_required)
 *   - src/server.ts (registerDashboard local signup/login deps)
 *   - src/dashboard/routes/confirmations.ts (owner approve route)
 *
 * Scenario (sequential `it`s share state through module-level vars):
 *   1. Signup owner          → 302 + Set-Cookie (local signup provisions tenant+owner)
 *   2. Owner issues API key   → op_live_… plaintext (effective role: operator)
 *   3. Owner invites operator → /dashboard/accept?token=… link
 *   4. Operator accepts+sets pw (PUBLIC) → 302 + Set-Cookie
 *   5. Operator logs in       → 302 + Set-Cookie
 *   6. RBAC loop:
 *        operator API key → register_domain → confirmation_required (propose ok)
 *        operator API key → confirm_pending → approver_role_required (cannot approve)
 *        owner dashboard   → /dashboard/confirmations/:id/approve → consumed,
 *                            upstream register POST fires (owner CAN approve)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
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
import {
  createDispatcher,
  type ConfirmDeps,
  type DispatcherTool,
} from '../../../src/mcp/dispatch.js';
import { createPgAuditSink } from '../../../src/audit/pg-sink.js';
import { createMcpServer } from '../../../src/mcp/transport.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerOverview } from '../../../src/dashboard/routes/overview.js';
import { registerOpenprovider } from '../../../src/dashboard/routes/openprovider.js';
import { registerPolicy } from '../../../src/dashboard/routes/policy.js';
import { registerKeys } from '../../../src/dashboard/routes/keys.js';
import { registerAudit } from '../../../src/dashboard/routes/audit.js';
import { registerConfirmations } from '../../../src/dashboard/routes/confirmations.js';
import { registerUsers } from '../../../src/dashboard/routes/users.js';
import { registerAccept } from '../../../src/dashboard/routes/accept.js';
import type { Principal } from '../../../src/auth/principal.js';

// Local-auth deps — same as src/server.ts wires into registerDashboard.
import { signup as signupFn, findUserByEmail } from '../../../src/auth/local-auth.js';
import { hashPassword, verifyPassword, assertPasswordPolicy } from '../../../src/auth/password.js';

// Phase 4/5 confirm-flow deps (clone of e2e.test.ts Phase 5 dispatchFactory).
import {
  getPolicy,
  liveSpendCents,
  proposeConfirmation,
  loadConfirmation,
  settleConfirmation,
  canonicalArgsHash,
  upsertPolicy,
} from '../../../src/policies/repo.js';
import { evaluate } from '../../../src/policies/engine.js';
import {
  toolMode,
  requiredApproverRoles,
  DEFAULT_POLICY,
  type Role,
} from '../../../src/policies/schema.js';
import { centsToEur } from '../../../src/policies/money.js';
import { createPricing, DRIFT_TOLERANCE } from '../../../src/policies/pricing.js';
import { createRegisterDomainTool } from '../../../src/tools/register-domain.js';
import { createCheckDomainTool } from '../../../src/tools/check-domain.js';
import { createListPendingConfirmationsTool } from '../../../src/tools/list-pending-confirmations.js';
import { createConfirmPendingTool } from '../../../src/tools/confirm-pending.js';
import { claimConfirmation, unclaimConfirmation } from '../../../src/policies/idempotency.js';
import type { LoadedConfirmation } from '../../../src/policies/repo.js';

const COOKIE_SECRET = 'test-cookie-secret-e2e-la-32chars!!';
const OWNER_EMAIL = 'owner-la@example.com';
const OWNER_PASSWORD = 'owner-password-1234'; // 12+ chars
const OPERATOR_EMAIL = 'operator-la@example.com';
const OPERATOR_PASSWORD = 'operator-pass-1234'; // 12+ chars

const kms = createFakeKms();
const KMS_KEY = 'fake-key';

// ---------------------------------------------------------------------------
// Cookie helper — capture the Set-Cookie header value (name=signedValue) and
// replay it as a Cookie header on subsequent requests.
// ---------------------------------------------------------------------------

/** Extract the op_dash cookie (name=value) from a Set-Cookie response header. */
function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no Set-Cookie header on response');
  // Set-Cookie: op_dash=<signed>; Path=/; HttpOnly; SameSite=Lax
  const first = setCookie.split(/,(?=\s*op_dash=)/)[0]!; // tolerate multiple cookies
  const pair = first.split(';')[0]!.trim();
  if (!pair.startsWith('op_dash=')) throw new Error(`unexpected Set-Cookie: ${setCookie}`);
  return pair;
}

/** Parse the CSRF token out of a signed op_dash cookie value (JSON before the `.` signature). */
function csrfFromCookie(cookiePair: string): string {
  const signed = decodeURIComponent(cookiePair.slice('op_dash='.length));
  // @fastify/cookie signs as `<value>.<signature>` — value is the JSON session.
  const json = signed.slice(0, signed.lastIndexOf('.'));
  const parsed = JSON.parse(json) as { csrf: string };
  return parsed.csrf;
}

describe('phase 6c e2e: local signup → invite → accept → login + RBAC approve loop', () => {
  let pgFixture: PgFixture | undefined;
  let pool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;
  let baseUrl = '';

  // State shared across the sequential `it`s.
  let ownerTenantId = '';
  let ownerCookie = '';
  let ownerCsrf = '';
  let operatorApiKey = '';
  let acceptToken = '';
  let confirmationId = '';

  const openproviderClient = createOpenproviderClient();

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;
    const poolRef = pool;

    // --- dispatchFactory: clone of e2e.test.ts Phase 5 wiring -----------------
    // register_domain → confirm with the DEFAULT approvers (owner/admin). The
    // /mcp caller is an API-key 'operator' principal, so propose succeeds but
    // confirm_pending fails with approver_role_required; the owner approves via
    // the real dashboard confirmations route.
    const CONFIRM_TTL_MS = 5 * 60 * 1000;

    async function dispatchFactory(principal: Principal) {
      const client = await poolRef.connect();
      let inTx = false;
      try {
        await client.query('BEGIN');
        inTx = true;
        await client.query('SET LOCAL ROLE app_role');
        await client.query('SELECT set_config($1, $2, true)', [
          'app.current_tenant',
          principal.tenantId,
        ]);

        const fetchCredentials = async (
          tid: string,
        ): Promise<{ username: string; password: string }> => {
          const u = await client.query<{ username: string }>(
            'SELECT username FROM openprovider_accounts WHERE tenant_id = $1',
            [tid],
          );
          const username = u.rows[0]?.username;
          if (!username) throw new OpenproviderAccountNotConnected();
          const store = createSecretsStore({
            kms,
            kmsKeyArn: KMS_KEY,
            repo: createDbSecretsRepo(client),
          });
          const passwordBuf = await store.get(tid, 'openprovider.password');
          if (!passwordBuf) throw new OpenproviderAccountNotConnected();
          return { username, password: passwordBuf.toString('utf8') };
        };

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

        const pricing = createPricing({ client: openproviderClient });

        const tokenManagerSafeToken = async (tid: string): Promise<string> => {
          try {
            return await tokenManager.getToken(tid);
          } catch (err) {
            if (err instanceof OpenproviderAccountNotConnected) return '';
            throw err;
          }
        };

        const validateConfirmation = async (
          token: string,
          args: unknown,
          p: Principal,
        ): Promise<{ kind: 'error'; code: string } | { kind: 'ok'; conf: LoadedConfirmation }> => {
          const conf = await loadConfirmation(client, token);
          if (!conf) return { kind: 'error', code: 'confirmation_not_found' };
          if (conf.consumedAt) return { kind: 'error', code: 'confirmation_not_found' };
          if (conf.expiresAt.getTime() <= Date.now()) {
            return { kind: 'error', code: 'confirmation_expired' };
          }
          if (!canonicalArgsHash(args, p.tenantId).equals(conf.argsHash)) {
            return { kind: 'error', code: 'validation_failed' };
          }
          const callerRole: Role =
            p.kind === 'user' ? p.role : p.scopes.includes('mcp:write') ? 'operator' : 'viewer';
          if (!conf.requiredApproverRoles.includes(callerRole)) {
            return { kind: 'error', code: 'approver_role_required' };
          }
          const freshToken = await tokenManagerSafeToken(p.tenantId);
          const fresh = await pricing.price(conf.toolName, args, freshToken);
          if (fresh > Math.round(conf.estimatedCostCents * (1 + DRIFT_TOLERANCE))) {
            await settleConfirmation(client, conf.id, 'released');
            return { kind: 'error', code: 'price_changed' };
          }
          return { kind: 'ok', conf };
        };

        const META_TOOLS = new Set(['confirm_pending', 'list_pending_confirmations']);

        const confirm: ConfirmDeps = {
          resolveMode: async (toolName) => {
            if (META_TOOLS.has(toolName)) return 'allow';
            const policy = await getPolicy(client, principal.tenantId);
            return toolMode(policy, toolName);
          },

          propose: async ({ toolName, args, principal: p }) => {
            await client.query('SELECT 1 FROM policies WHERE tenant_id = $1 FOR UPDATE', [
              p.tenantId,
            ]);
            const policy = await getPolicy(client, p.tenantId);
            const live = await liveSpendCents(client, p.tenantId);
            const opToken = await tokenManagerSafeToken(p.tenantId);
            const estimatedCostCents = await pricing.price(toolName, args, opToken);
            const callerRole: Role =
              p.kind === 'user' ? p.role : p.scopes.includes('mcp:write') ? 'operator' : 'viewer';
            const tldsInArgs: string[] = [];
            if (toolName === 'register_domain' || toolName === 'update_domain') {
              const a = args as { domain?: { extension: string } };
              if (a.domain) tldsInArgs.push(a.domain.extension);
            }
            const decision = evaluate({
              toolName,
              args,
              role: callerRole,
              policy,
              liveSpendCents: live,
              estimatedCostCents,
              tldsInArgs,
            });
            if (decision.decision === 'deny') {
              return { kind: 'denied', reason: decision.reason ?? 'denied' };
            }
            if (decision.decision === 'allow') {
              return { kind: 'denied', reason: 'not_confirm_mode' };
            }
            const approvers = requiredApproverRoles(policy, toolName);
            const rec = await proposeConfirmation({
              client,
              tenantId: p.tenantId,
              principalSubject: p.subject,
              toolName,
              args,
              summaryText: `${toolName} (est. €${centsToEur(estimatedCostCents)})`,
              estimatedCostCents,
              requiredApproverRoles: approvers,
              ttlMs: CONFIRM_TTL_MS,
            });
            return {
              kind: 'proposed',
              result: {
                confirmationId: rec.id,
                confirmationToken: rec.id,
                summary: rec.summaryText,
                estimatedCostEur: centsToEur(rec.estimatedCostCents),
                requiredApproverRoles: rec.requiredApproverRoles,
                expiresAt: rec.expiresAt.toISOString(),
              },
            };
          },

          consume: async ({ token, args, principal: p }) => {
            const validated = await validateConfirmation(token, args, p);
            if (validated.kind === 'error') return validated;
            const won = await claimConfirmation(client, validated.conf.id);
            if (!won) return { kind: 'error', code: 'confirmation_not_found' };
            return { kind: 'ok', confirmationId: validated.conf.id };
          },

          settle: async (cid, outcome) => {
            if (outcome === 'released') await unclaimConfirmation(client, cid);
            await settleConfirmation(client, cid, outcome);
          },
        };

        const tools: DispatcherTool[] = [
          createCheckDomainTool({ client: openproviderClient, tokenManager }),
          createRegisterDomainTool({ client: openproviderClient, tokenManager }),
          createListPendingConfirmationsTool({ getClient: () => client }),
        ];

        const confirmPendingConsume = async (input: {
          confirmationId: string;
          args: unknown;
          principal: Principal;
        }): Promise<{ kind: 'error'; code: string } | { kind: 'ok'; result: unknown }> => {
          const validated = await validateConfirmation(
            input.confirmationId,
            input.args,
            input.principal,
          );
          if (validated.kind === 'error') return validated;
          const { conf } = validated;
          const originalTool = tools.find((t) => t.name === conf.toolName);
          if (!originalTool) return { kind: 'error', code: 'tool_not_found' };
          const won = await claimConfirmation(client, conf.id);
          if (!won) return { kind: 'error', code: 'confirmation_not_found' };
          try {
            const result = await originalTool.handler(input.args, input.principal);
            await settleConfirmation(client, conf.id, 'committed');
            return { kind: 'ok', result };
          } catch (err) {
            await unclaimConfirmation(client, conf.id);
            await settleConfirmation(client, conf.id, 'released');
            const code = (err as { code?: string }).code ?? 'upstream_error';
            return { kind: 'error', code };
          }
        };

        tools.push(createConfirmPendingTool({ consume: confirmPendingConsume }));

        const dispatch = createDispatcher({
          tools,
          audit: createPgAuditSink(client),
          confirm,
        });

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

    app = await createMcpServer({
      devToken: 'never-used-la-e2e',
      devPrincipal: {
        kind: 'user',
        tenantId: '00000000-0000-0000-0000-000000000000',
        userId: '00000000-0000-0000-0000-000000000000',
        subject: 'dev',
        scopes: [],
        role: 'viewer',
      },
      apiKeyResolver: createApiKeyResolver(poolRef),
      dispatchFactory,
    });

    // registerDashboard with the SAME local-auth deps src/server.ts wires.
    await registerDashboard(app, {
      cookieSecret: COOKIE_SECRET,
      signup: async (email, password) => {
        try {
          assertPasswordPolicy(password);
        } catch {
          return { status: 'invalid_password' as const };
        }
        const r = await signupFn(poolRef, email, await hashPassword(password));
        return r.status === 'created'
          ? {
              status: 'created' as const,
              tenantId: r.tenantId,
              userId: r.userId,
              role: r.role,
              email,
            }
          : { status: 'email_taken' as const };
      },
      login: async (email, password) => {
        const u = await findUserByEmail(poolRef, email);
        if (!u || !u.passwordHash || !(await verifyPassword(u.passwordHash, password))) {
          return { ok: false as const };
        }
        return { ok: true as const, tenantId: u.tenantId, userId: u.userId, role: u.role, email };
      },
      registerPages: (pageApp) => {
        registerOverview(pageApp, { pool: poolRef });
        registerOpenprovider(pageApp, { pool: poolRef, kms, kmsKeyName: KMS_KEY });
        registerPolicy(pageApp, { pool: poolRef });
        registerKeys(pageApp, { pool: poolRef });
        registerAudit(pageApp, { pool: poolRef });
        registerConfirmations(pageApp, {
          pool: poolRef,
          kms,
          kmsKeyName: KMS_KEY,
          openproviderClient,
        });
        registerUsers(pageApp, { pool: poolRef });
        registerAccept(pageApp, { pool: poolRef });
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
  // MCP helpers (real HTTP — clone of e2e.test.ts Phase 5 helpers)
  // ---------------------------------------------------------------------------

  async function mcpInitSession(bearer: string): Promise<string> {
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
          clientInfo: { name: 'e2e-la', version: '0' },
        },
      }),
    });
    expect(r.status).toBe(200);
    const sid = r.headers.get('mcp-session-id');
    if (!sid) throw new Error('initialize did not return Mcp-Session-Id');
    return sid;
  }

  async function mcpCallTool(
    sid: string,
    bearer: string,
    toolName: string,
    toolArgs: unknown,
  ): Promise<unknown> {
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
        params: { name: toolName, arguments: toolArgs },
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

  // The register args reused for propose + confirm — the canonical hash must match.
  const domainArgs = {
    domain: { name: 'rbac-example', extension: 'com' },
    period: 1,
    owner_handle: 'OWNER-LA',
  };

  // ---------------------------------------------------------------------------
  // Step 1: signup owner → 302 + Set-Cookie (local signup provisions tenant+owner)
  // ---------------------------------------------------------------------------
  it('step 1: POST /dashboard/signup provisions a tenant + owner and sets a session', async () => {
    const res = await fetch(`${baseUrl}/dashboard/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `email=${encodeURIComponent(OWNER_EMAIL)}&password=${encodeURIComponent(OWNER_PASSWORD)}`,
      redirect: 'manual',
    });

    expect(res.status, 'signup should 302 to /dashboard').toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');

    ownerCookie = extractSessionCookie(res);
    ownerCsrf = csrfFromCookie(ownerCookie);
    expect(ownerCookie).toMatch(/^op_dash=/);
    expect(ownerCsrf).toBeTruthy();

    // The owner user + tenant now exist; capture the tenant id for later seeding.
    const u = await findUserByEmail(pool!, OWNER_EMAIL);
    expect(u, 'owner user should exist after signup').not.toBeNull();
    expect(u!.role).toBe('owner');
    ownerTenantId = u!.tenantId;
    expect(ownerTenantId).toBeTruthy();
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 2: owner issues an API key → op_live_… plaintext (effective role operator)
  // ---------------------------------------------------------------------------
  it('step 2: owner issues an API key (op_live_) via the dashboard', async () => {
    const res = await fetch(`${baseUrl}/dashboard/keys/issue`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: ownerCookie,
      },
      body: `_csrf=${encodeURIComponent(ownerCsrf)}&name=RBACOperatorKey`,
      redirect: 'manual',
    });

    expect(res.status, 'issue should return 200 (re-renders keys page)').toBe(200);
    const html = await res.text();
    const match = html.match(/op_live_[A-Za-z0-9_-]+/);
    expect(match, 'issue response must contain the plaintext op_live_ key').not.toBeNull();
    operatorApiKey = match![0]!;
    expect(operatorApiKey).toMatch(/^op_live_/);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 3: owner invites an operator → /dashboard/accept?token=… link
  // ---------------------------------------------------------------------------
  it('step 3: owner invites an operator → accept link is shown', async () => {
    const res = await fetch(`${baseUrl}/dashboard/users/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: ownerCookie,
      },
      body: `_csrf=${encodeURIComponent(ownerCsrf)}&email=${encodeURIComponent(OPERATOR_EMAIL)}&role=operator`,
      redirect: 'manual',
    });

    expect(res.status, 'invite should return 200 (re-renders users page)').toBe(200);
    const html = await res.text();
    const match = html.match(/\/dashboard\/accept\?token=([A-Za-z0-9_-]+)/);
    expect(match, 'invite response must contain a /dashboard/accept?token=… link').not.toBeNull();
    acceptToken = match![1]!;
    expect(acceptToken).toBeTruthy();
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 4: operator accepts + sets password (PUBLIC) → 302 + Set-Cookie
  // ---------------------------------------------------------------------------
  it('step 4: operator accepts the invite + sets a password (public, no session)', async () => {
    const res = await fetch(`${baseUrl}/dashboard/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(acceptToken)}&password=${encodeURIComponent(OPERATOR_PASSWORD)}`,
      redirect: 'manual',
    });

    expect(res.status, 'accept should 302 to /dashboard').toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    const acceptCookie = extractSessionCookie(res);
    expect(acceptCookie).toMatch(/^op_dash=/);

    // The operator user now exists with role operator in the owner's tenant.
    const u = await findUserByEmail(pool!, OPERATOR_EMAIL);
    expect(u, 'operator user should exist after accepting the invite').not.toBeNull();
    expect(u!.role).toBe('operator');
    expect(u!.tenantId).toBe(ownerTenantId);
    expect(u!.passwordHash, 'accept must have set the operator password hash').toBeTruthy();
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 5: operator logs in with the password they just set → 302 + Set-Cookie
  // ---------------------------------------------------------------------------
  it('step 5: operator logs in with the password set during accept', async () => {
    const res = await fetch(`${baseUrl}/dashboard/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `email=${encodeURIComponent(OPERATOR_EMAIL)}&password=${encodeURIComponent(OPERATOR_PASSWORD)}`,
      redirect: 'manual',
    });

    expect(res.status, 'operator login should 302 to /dashboard').toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    const loginCookie = extractSessionCookie(res);
    expect(loginCookie).toMatch(/^op_dash=/);
    expect(csrfFromCookie(loginCookie)).toBeTruthy();
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 6: RBAC over /mcp + dashboard.
  //   - Seed OP creds + raise spend cap (default cap is €0, default approvers owner/admin).
  //   - operator API key proposes register_domain → confirmation_required.
  //   - operator API key confirm_pending → approver_role_required (cannot approve).
  //   - owner approves via /dashboard/confirmations/:id/approve → upstream register fires.
  // ---------------------------------------------------------------------------
  it('step 6a: seed OP creds + raise spend cap; operator API key proposes register_domain → confirmation_required', async () => {
    // Seed Openprovider account + encrypted password, and raise the spend cap so
    // propose reaches the confirmation step. Keep DEFAULT approvers (owner/admin)
    // so the operator caller cannot self-approve.
    await runAsTenant(pool!, ownerTenantId, async (client) => {
      await client.query(
        `INSERT INTO openprovider_accounts (tenant_id, username)
           VALUES ($1, 'op-la')
           ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username`,
        [ownerTenantId],
      );
      const store = createSecretsStore({
        kms,
        kmsKeyArn: KMS_KEY,
        repo: createDbSecretsRepo(client),
      });
      await store.put(ownerTenantId, 'openprovider.password', Buffer.from('pw-la'));

      // Raise spend cap; register_domain stays at default 'confirm' with default
      // approvers (owner/admin) — do NOT add 'operator' as an approver here.
      await upsertPolicy(client, ownerTenantId, {
        ...DEFAULT_POLICY,
        spend_caps: { window: 'month', limit_eur: 100 },
      });
    });

    // Nock: login + checkDomain (for pricing during propose).
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .reply(200, { data: { token: 'jwt-la-propose', reseller_id: 1 } });
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(200, {
        data: {
          results: [
            {
              domain: 'rbac-example.com',
              status: 'free',
              is_premium: false,
              price: { product: { price: 12.99, currency: 'EUR' } },
            },
          ],
        },
      });

    const sid = await mcpInitSession(operatorApiKey);
    const proposeBody = (await mcpCallTool(sid, operatorApiKey, 'register_domain', domainArgs)) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    const proposeText = proposeBody.result?.content[0]?.text;
    expect(
      proposeText,
      'operator propose should return confirmation_required, got: ' + JSON.stringify(proposeBody),
    ).toBeDefined();
    const proposeResult = JSON.parse(proposeText ?? '{}') as {
      confirmationId?: string;
      requiredApproverRoles?: string[];
      estimatedCostEur?: number;
    };
    expect(proposeResult.confirmationId, 'confirmationId must be present').toBeTruthy();
    expect(proposeResult.estimatedCostEur).toBe(12.99);
    // Default approvers are owner/admin — operator is NOT among them.
    expect(proposeResult.requiredApproverRoles).toEqual(['owner', 'admin']);
    confirmationId = proposeResult.confirmationId!;
  }, 90_000);

  it('step 6b: operator API key confirm_pending → approver_role_required (operator cannot approve)', async () => {
    // Re-pricing may run during validateConfirmation — make login/check optional.
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .optionally()
      .reply(200, { data: { token: 'jwt-la-conf', reseller_id: 1 } });
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .optionally()
      .reply(200, {
        data: {
          results: [
            {
              domain: 'rbac-example.com',
              status: 'free',
              is_premium: false,
              price: { product: { price: 12.99, currency: 'EUR' } },
            },
          ],
        },
      });

    const sid = await mcpInitSession(operatorApiKey);
    const confirmBody = (await mcpCallTool(sid, operatorApiKey, 'confirm_pending', {
      confirmation_id: confirmationId,
      args: domainArgs,
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    // The operator effective role (operator) is not an allowed approver → rejected
    // BEFORE the confirmation is consumed (no upstream register fires).
    expect(
      confirmBody.result,
      'operator confirm_pending must NOT succeed, got: ' + JSON.stringify(confirmBody),
    ).toBeUndefined();
    expect(
      JSON.stringify(confirmBody),
      'operator confirm_pending should fail with approver_role_required, got: ' +
        JSON.stringify(confirmBody),
    ).toContain('approver_role_required');

    // The confirmation must still be pending (not consumed) for the owner to approve.
    await runAsTenant(pool!, ownerTenantId, async (client) => {
      const r = await client.query<{ consumed_at: Date | null }>(
        'SELECT consumed_at FROM confirmations WHERE id = $1',
        [confirmationId],
      );
      expect(
        r.rows[0]?.consumed_at,
        'confirmation must remain unconsumed after operator reject',
      ).toBeNull();
    });
  }, 90_000);

  it('step 6c: owner approves via /dashboard/confirmations/:id/approve → consumed, upstream register fires', async () => {
    // The dashboard confirmations route builds its OWN consume path (its own
    // tokenManager + pricing), so Nock login + re-price checkDomain + the actual
    // register POST. The register interceptor must fire exactly once.
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .optionally()
      .reply(200, { data: { token: 'jwt-la-approve', reseller_id: 1 } });
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .optionally()
      .reply(200, {
        data: {
          results: [
            {
              domain: 'rbac-example.com',
              status: 'free',
              is_premium: false,
              price: { product: { price: 12.99, currency: 'EUR' } },
            },
          ],
        },
      });
    const registerScope = nock('https://api.openprovider.eu')
      .post('/v1beta/domains')
      .reply(200, { data: { id: 7, status: 'ACT' } });

    const res = await fetch(`${baseUrl}/dashboard/confirmations/${confirmationId}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: ownerCookie,
      },
      body: `_csrf=${encodeURIComponent(ownerCsrf)}`,
      redirect: 'manual',
    });

    expect(res.status, 'owner approve should return 200 (re-renders confirmations page)').toBe(200);
    const html = await res.text();

    // The owner principal has role owner → passes the approver check (NOT rejected
    // with approver_role_required), and the consume path runs through to success.
    expect(
      html,
      'owner approval must NOT fail with approver_role_required, got page: ' + html.slice(0, 600),
    ).not.toContain('approver_role_required');
    expect(html, 'owner approval should report success').toContain('approved and executed');

    // The upstream register POST must have fired exactly once.
    expect(
      registerScope.isDone(),
      'POST /v1beta/domains must have fired exactly once on owner approval',
    ).toBe(true);

    // The confirmation is now consumed (committed reservation).
    await runAsTenant(pool!, ownerTenantId, async (client) => {
      const r = await client.query<{ consumed_at: Date | null }>(
        'SELECT consumed_at FROM confirmations WHERE id = $1',
        [confirmationId],
      );
      expect(
        r.rows[0]?.consumed_at,
        'confirmation must be consumed after owner approval',
      ).not.toBeNull();
    });
  }, 90_000);
});

/**
 * Phase 6b marquee e2e: cross-user RBAC over real HTTP /mcp.
 *
 * Two real users in ONE tenant:
 *   - OWNER  (provisioned via resolve_or_provision_tenant → role 'owner')
 *   - OPERATOR (joined via the Phase-6b invite/accept flow → role 'operator')
 *
 * Scenario:
 *   1. Operator proposes register_domain → confirmation_required (returns a confirmation id).
 *   2. Operator tries to confirm it → rejected (approver_role_required).
 *   3. Owner approves the SAME confirmation → succeeds; the upstream Openprovider POST fires.
 *
 * Auth is via a FAKE OAuth verifier (not API keys) so every /mcp call carries a real
 * per-user role that flows resolve_or_provision_tenant → identity → dispatch.
 *
 * The dispatchFactory + MCP HTTP helpers + Openprovider Nock setup + policy seeding are
 * cloned from tests/integration/mcp/e2e.test.ts (Phase 5) and
 * tests/integration/mcp/dashboard-key-e2e.test.ts. No production code changes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createTenantResolver } from '../../../src/auth/tenant-resolver.js';
import type { AccessTokenVerifier } from '../../../src/auth/oauth/workos.js';
import { createMcpServer } from '../../../src/mcp/transport.js';
import { createFakeKms } from '../../../src/secrets/fake-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import {
  createDispatcher,
  type ConfirmDeps,
  type DispatcherTool,
} from '../../../src/mcp/dispatch.js';
import { createPgAuditSink } from '../../../src/audit/pg-sink.js';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';
import { createOpenproviderTokenManager } from '../../../src/openprovider/token-manager.js';
import { createPgTokenCache } from '../../../src/openprovider/token-cache-pg.js';
import { OpenproviderAccountNotConnected } from '../../../src/openprovider/errors.js';
import type { Principal } from '../../../src/auth/principal.js';

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
import { createListPendingConfirmationsTool } from '../../../src/tools/list-pending-confirmations.js';
import { createConfirmPendingTool } from '../../../src/tools/confirm-pending.js';
import type { LoadedConfirmation } from '../../../src/policies/repo.js';

import { createRegisterDomainTool } from '../../../src/tools/register-domain.js';
import { createCreateContactTool } from '../../../src/tools/create-contact.js';
import { createUpdateDomainTool } from '../../../src/tools/update-domain.js';
import { createUpdateContactTool } from '../../../src/tools/update-contact.js';
import { createDeleteContactTool } from '../../../src/tools/delete-contact.js';
import {
  claimConfirmation,
  unclaimConfirmation,
  withIdempotency,
  idempotencyKeyFor,
} from '../../../src/policies/idempotency.js';
import { createPricing, DRIFT_TOLERANCE } from '../../../src/policies/pricing.js';

// ---------------------------------------------------------------------------
// Fake OAuth verifier — maps two opaque bearer tokens onto two real users.
// ---------------------------------------------------------------------------

const OWNER_BEARER = 'owner-bearer-token';
const OPERATOR_BEARER = 'operator-bearer-token';

const verifier: AccessTokenVerifier = (token: string) => {
  if (token === OWNER_BEARER) {
    return Promise.resolve({
      subject: 'rbac_owner_sub',
      email: 'rbac-owner@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });
  }
  if (token === OPERATOR_BEARER) {
    return Promise.resolve({
      subject: 'rbac_operator_sub',
      email: 'rbac-operator@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });
  }
  return Promise.reject(new Error('bad token'));
};

describe('phase 6b e2e: operator proposes register_domain; owner approves', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let baseUrl: string;
  let tenantId: string;

  const CONFIRM_TTL_MS = 5 * 60 * 1000;

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    // -----------------------------------------------------------------------
    // Provision the OWNER (resolve_or_provision_tenant → role 'owner').
    // -----------------------------------------------------------------------
    {
      const c = await pool.connect();
      try {
        await c.query('SET ROLE app_role');
        const r = await c.query<{ tenant_id: string }>(
          'SELECT * FROM resolve_or_provision_tenant($1,$2)',
          ['rbac_owner_sub', 'rbac-owner@example.com'],
        );
        tenantId = r.rows[0]!.tenant_id;
      } finally {
        await c.query('RESET ROLE');
        c.release();
      }
    }

    // -----------------------------------------------------------------------
    // Invite + accept the OPERATOR into the SAME tenant.
    // -----------------------------------------------------------------------
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'rbac-operator@example.com', 'operator', 'rbac-op-tok', now() + interval '7 days')`,
        [tenantId],
      );
    });
    {
      const ac = await pool.connect();
      try {
        await ac.query('SET ROLE app_role');
        const r = await ac.query<{ status: string }>('SELECT * FROM accept_invitation($1,$2,$3)', [
          'rbac-op-tok',
          'rbac_operator_sub',
          'rbac-operator@example.com',
        ]);
        expect(r.rows[0]!.status).toBe('accepted');
      } finally {
        await ac.query('RESET ROLE');
        ac.release();
      }
    }

    // -----------------------------------------------------------------------
    // Seed Openprovider account + encrypted password, and raise the spend cap.
    //
    // resolve_or_provision_tenant already seeds register_domain:'confirm', but the
    // DEFAULT policy has spend_caps.limit_eur: 0 — register_domain pricing (€12.99)
    // would trip a spend cap before the approver check. Raise it to €1000 (mirrors
    // e2e.test.ts p5ProvisionTenant, which upserts DEFAULT_POLICY with a higher cap).
    // -----------------------------------------------------------------------
    const kms = createFakeKms();
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO openprovider_accounts (tenant_id, username) VALUES ($1, 'op-rbac')
           ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username`,
        [tenantId],
      );
      const store = createSecretsStore({
        kms,
        kmsKeyArn: 'fake-key',
        repo: createDbSecretsRepo(client),
      });
      await store.put(tenantId, 'openprovider.password', Buffer.from('pw-rbac'));

      // DEFAULT_POLICY already has register_domain:'confirm'. Just raise the cap.
      await upsertPolicy(client, tenantId, {
        ...DEFAULT_POLICY,
        spend_caps: { window: 'month', limit_eur: 1000 },
      });
    });

    // -----------------------------------------------------------------------
    // dispatchFactory — cloned VERBATIM from e2e.test.ts Phase 5 p5DispatchFactory.
    // -----------------------------------------------------------------------
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

        const kmsLocal = createFakeKms();

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
            kms: kmsLocal,
            kmsKeyArn: 'fake-key',
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
              return kmsLocal.decrypt(r.rows[0].kms_key_arn, r.rows[0].wrapped_dek);
            },
          }),
        });

        const opClient = createOpenproviderClient();
        const pricing = createPricing({ client: opClient });

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
          const callerRole: Role | '' = p.kind === 'user' ? p.role : '';
          if (!conf.requiredApproverRoles.includes(callerRole as Role)) {
            return { kind: 'error', code: 'approver_role_required' };
          }
          // Re-price with real pricing (Nock intercepts the upstream checkDomain).
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
            const callerRole: Role = p.kind === 'user' ? p.role : 'viewer';
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

          // Path 1 consume: validates + atomically claims.
          consume: async ({ token, args, principal: p }) => {
            const validated = await validateConfirmation(token, args, p);
            if (validated.kind === 'error') return validated;
            const won = await claimConfirmation(client, validated.conf.id);
            if (!won) return { kind: 'error', code: 'confirmation_not_found' };
            return { kind: 'ok', confirmationId: validated.conf.id };
          },

          settle: async (confirmationId, outcome) => {
            if (outcome === 'released') await unclaimConfirmation(client, confirmationId);
            await settleConfirmation(client, confirmationId, outcome);
          },
        };

        // create_contact wrapped with withIdempotency (allow-mode).
        const baseCreateContactTool = createCreateContactTool({
          client: opClient,
          tokenManager,
        });
        const wrappedCreateContact: DispatcherTool = {
          ...baseCreateContactTool,
          handler: async (args: unknown, p: Principal): Promise<unknown> => {
            const key = idempotencyKeyFor('create_contact', args, p.tenantId);
            const { result } = await withIdempotency(
              client,
              p.tenantId,
              key,
              'create_contact',
              () => baseCreateContactTool.handler(args, p),
            );
            return result;
          },
        };

        const tools: DispatcherTool[] = [
          createRegisterDomainTool({ client: opClient, tokenManager }),
          createUpdateDomainTool({ client: opClient, tokenManager }),
          wrappedCreateContact,
          createUpdateContactTool({ client: opClient, tokenManager }),
          createDeleteContactTool({ client: opClient, tokenManager }),
          createListPendingConfirmationsTool({ getClient: () => client }),
        ];

        // Path 2: confirm_pending — validates + claims + executes the original tool.
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

          // Atomic claim — prevents concurrent double-execution.
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
      devToken: 'never-used-rbac',
      devPrincipal: {
        kind: 'user',
        tenantId: '00000000-0000-0000-0000-000000000000',
        userId: '00000000-0000-0000-0000-000000000000',
        subject: 'dev',
        scopes: [],
        role: 'viewer',
      },
      verifier,
      resolveTenant: createTenantResolver(pool),
      dispatchFactory,
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
  // MCP HTTP helpers (cloned from e2e.test.ts / dashboard-key-e2e.test.ts).
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
          clientInfo: { name: 'e2e-rbac', version: '0' },
        },
      }),
    });
    const sid = r.headers.get('mcp-session-id') ?? '';
    return { sid, status: r.status };
  }

  async function callTool(
    sid: string,
    bearer: string,
    name: string,
    args: unknown,
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
        params: { name, arguments: args },
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
  // The marquee scenario
  // ---------------------------------------------------------------------------

  it('operator proposes register_domain; operator confirm rejected; owner confirm approves', async () => {
    const domainArgs = {
      domain: { name: 'example', extension: 'com' },
      period: 1,
      owner_handle: 'OWNER-01',
    };

    // ── 1. Operator proposes register_domain → confirmation_required ──────────
    // Pricing calls checkDomain (login + check) during propose.
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .reply(200, { data: { token: 'jwt-rbac-propose', reseller_id: 1 } });
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(200, {
        data: {
          results: [
            {
              domain: 'example.com',
              status: 'free',
              is_premium: false,
              price: { product: { price: 12.99, currency: 'EUR' } },
            },
          ],
        },
      });

    const { sid: opSid } = await mcpInitSession(OPERATOR_BEARER);
    const propose = (await callTool(opSid, OPERATOR_BEARER, 'register_domain', domainArgs)) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    const proposeText = propose.result?.content[0]?.text;
    expect(
      proposeText,
      'operator propose should return confirmation_required, got: ' + JSON.stringify(propose),
    ).toBeDefined();
    const proposeResult = JSON.parse(proposeText ?? '{}') as {
      confirmationId?: string;
      estimatedCostEur?: number;
    };
    const confirmationId = proposeResult.confirmationId!;
    expect(confirmationId, 'confirmationId must be present').toBeTruthy();
    expect(proposeResult.estimatedCostEur).toBe(12.99);

    // ── 2. Nock upstream so an approval would actually execute ────────────────
    // (login + check for re-pricing during validate, + ONE register slot).
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .optionally()
      .reply(200, { data: { token: 'jwt-rbac-confirm', reseller_id: 1 } });
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .optionally()
      .reply(200, {
        data: {
          results: [
            {
              domain: 'example.com',
              status: 'free',
              is_premium: false,
              price: { product: { price: 12.99, currency: 'EUR' } },
            },
          ],
        },
      });
    const registerScope = nock('https://api.openprovider.eu')
      .post('/v1beta/domains')
      .reply(200, { data: { id: 42, status: 'ACT' } });

    // ── 3. Operator tries to confirm → rejected (approver_role_required) ──────
    const { sid: opSid2 } = await mcpInitSession(OPERATOR_BEARER);
    const opConfirm = await callTool(opSid2, OPERATOR_BEARER, 'confirm_pending', {
      confirmation_id: confirmationId,
      args: domainArgs,
    });
    expect(
      JSON.stringify(opConfirm),
      'operator confirm must be rejected with approver_role_required: ' + JSON.stringify(opConfirm),
    ).toMatch(/approver_role_required/);

    // The losing operator confirm must NOT have reached upstream registration.
    expect(
      registerScope.isDone(),
      'operator confirm must not have fired the upstream register POST',
    ).toBe(false);

    // ── 4. Owner approves the SAME confirmation → succeeds ────────────────────
    const { sid: ownSid } = await mcpInitSession(OWNER_BEARER);
    const ownConfirm = (await callTool(ownSid, OWNER_BEARER, 'confirm_pending', {
      confirmation_id: confirmationId,
      args: domainArgs,
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    expect(
      JSON.stringify(ownConfirm),
      'owner confirm must NOT be rejected: ' + JSON.stringify(ownConfirm),
    ).not.toMatch(/approver_role_required/);

    const ownConfirmText = ownConfirm.result?.content[0]?.text;
    expect(
      ownConfirmText,
      'owner confirm_pending should succeed, got: ' + JSON.stringify(ownConfirm),
    ).toBeDefined();
    const ownConfirmResult = JSON.parse(ownConfirmText ?? '{}') as { id?: number; status?: string };
    expect(ownConfirmResult.id).toBe(42);

    // The upstream Openprovider register POST must have fired exactly once.
    expect(
      registerScope.isDone(),
      'owner approval must have fired the upstream register POST exactly once',
    ).toBe(true);
  }, 180_000);
});

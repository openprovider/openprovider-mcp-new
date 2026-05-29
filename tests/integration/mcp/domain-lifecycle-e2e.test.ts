/**
 * Domain-lifecycle dispatch + policy integration test (Phase — batch 1).
 *
 * Proves that the 11 new domain-lifecycle tools are wired into the dispatcher
 * and that DEFAULT_POLICY modes (allow vs confirm) and the viewer write-gate
 * behave correctly end-to-end through the real HTTP stack, without making real
 * Openprovider network calls.
 *
 * Mirrors the e2e.test.ts Phase 5 harness exactly:
 *   - same 120_000 beforeAll timeout
 *   - defensive afterAll (pool?.end() then fixture?.stop())
 *   - seedTenantOwner + issueApiKey for principal provisioning
 *   - full ConfirmDeps wired with DEFAULT_POLICY tools map
 *   - operator key (mcp:read + mcp:write) → resolves to 'operator' callerRole
 *   - viewer  key (mcp:read only)         → resolves to 'viewer'  callerRole
 *
 * Asserted discriminators:
 *   - allow-mode tool with no OP creds:  error.data.code === 'openprovider_not_connected'
 *   - confirm-mode tool (no token):       result.content[0].text parsed → { confirmationId }
 *   - viewer calling write tool:          error.data.code === 'policy_denied'
 *   - viewer calling read tool:           same not-connected outcome as operator
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant, seedTenantOwner } from '../_helpers/db.js';
import { issueApiKey, createApiKeyResolver } from '../../../src/auth/api-key.js';

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
} from '../../../src/policies/repo.js';
import { resolveToolMode } from '../../../src/policies/engine.js';
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
import { claimConfirmation, unclaimConfirmation } from '../../../src/policies/idempotency.js';
import type { LoadedConfirmation } from '../../../src/policies/repo.js';
import { createPricing, DRIFT_TOLERANCE } from '../../../src/policies/pricing.js';

// The 11 new domain-lifecycle tools.
import { createSuggestDomainTool } from '../../../src/tools/suggest-domain.js';
import { createGetDomainAuthcodeTool } from '../../../src/tools/get-domain-authcode.js';
import { createResetDomainAuthcodeTool } from '../../../src/tools/reset-domain-authcode.js';
import { createApproveDomainTransferTool } from '../../../src/tools/approve-domain-transfer.js';
import { createSendFoa1DomainTransferTool } from '../../../src/tools/send-foa1-domain-transfer.js';
import { createDeleteDomainTool } from '../../../src/tools/delete-domain.js';
import { createRestartDomainOperationTool } from '../../../src/tools/restart-domain-operation.js';
import { createRenewDomainTool } from '../../../src/tools/renew-domain.js';
import { createTransferDomainTool } from '../../../src/tools/transfer-domain.js';
import { createTradeDomainTool } from '../../../src/tools/trade-domain.js';
import { createRestoreDomainTool } from '../../../src/tools/restore-domain.js';

// Also needed for tools/list via buildToolCatalog.
import { buildToolCatalog } from '../../../src/mcp/tool-catalog.js';

const CONFIRM_TTL_MS = 5 * 60 * 1000;

/** Issue an API key inside the tenant's RLS context. */
async function issueTenantKey(
  pool: pg.Pool,
  tenantId: string,
  name: string,
  scopes: string[],
): Promise<string> {
  return runAsTenant(pool, tenantId, async (client) => {
    const issued = await issueApiKey(client, { tenantId, name, scopes });
    return issued.key;
  });
}

describe('domain-lifecycle dispatch + policy e2e', () => {
  let pgFixture: PgFixture | undefined;
  let pool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;
  let baseUrl: string;

  /** operator key: mcp:read + mcp:write → callerRole = 'operator' */
  let operatorKey: string;
  /** viewer  key: mcp:read only         → callerRole = 'viewer'   */
  let viewerKey: string;

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    const kms = createFakeKms();

    // Provision a single tenant (no OP creds — we want the not-connected path).
    const seeded = await seedTenantOwner(pool, 'dl-e2e@example.com', 'x-hash-dl');
    const tenantId = seeded.tenant_id;

    operatorKey = await issueTenantKey(pool, tenantId, 'dl-operator-key', [
      'mcp:read',
      'mcp:write',
    ]);
    viewerKey = await issueTenantKey(pool, tenantId, 'dl-viewer-key', ['mcp:read']);

    const openproviderClient = createOpenproviderClient();

    // dispatchFactory mirrors server.ts Phase-5 wiring exactly, including:
    //   - resolveToolMode (role-aware, viewer gate)
    //   - real ConfirmDeps + propose/consume/settle
    //   - all 11 new domain-lifecycle tools
    //   - no real OP creds so suggest_domain / get_domain_authcode will throw not-connected
    async function dispatchFactory(principal: Principal) {
      const client = await pool!.connect();
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
              return kms.decrypt(r.rows[0].kms_key_arn, r.rows[0].wrapped_dek);
            },
          }),
        });

        const tokenManagerSafeToken = async (tenantId: string): Promise<string> => {
          try {
            return await tokenManager.getToken(tenantId);
          } catch (err) {
            if (err instanceof OpenproviderAccountNotConnected) return '';
            throw err;
          }
        };

        const pricing = createPricing({ client: openproviderClient });

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
          const freshToken = await tokenManagerSafeToken(p.tenantId);
          const fresh = freshToken ? await pricing.price(conf.toolName, args, freshToken) : 0;
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
            const callerRole: Role =
              principal.kind === 'user'
                ? principal.role
                : principal.scopes.includes('mcp:write')
                  ? 'operator'
                  : 'viewer';
            return resolveToolMode(policy, toolName, callerRole);
          },

          propose: async ({ toolName, args, principal: p }) => {
            await client.query('SELECT 1 FROM policies WHERE tenant_id = $1 FOR UPDATE', [
              p.tenantId,
            ]);
            const policy = await getPolicy(client, p.tenantId);
            const live = await liveSpendCents(client, p.tenantId);
            const opToken = await tokenManagerSafeToken(p.tenantId);
            const estimatedCostCents = opToken ? await pricing.price(toolName, args, opToken) : 0;
            const callerRole: Role =
              p.kind === 'user' ? p.role : p.scopes.includes('mcp:write') ? 'operator' : 'viewer';
            const decision = evaluate({
              toolName,
              args,
              role: callerRole,
              policy,
              liveSpendCents: live,
              estimatedCostCents,
              tldsInArgs: [],
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

          settle: async (confirmationId, outcome) => {
            if (outcome === 'released') await unclaimConfirmation(client, confirmationId);
            await settleConfirmation(client, confirmationId, outcome);
          },
        };

        const tools: DispatcherTool[] = [
          createSuggestDomainTool({ client: openproviderClient, tokenManager }),
          createGetDomainAuthcodeTool({ client: openproviderClient, tokenManager }),
          createResetDomainAuthcodeTool({ client: openproviderClient, tokenManager }),
          createApproveDomainTransferTool({ client: openproviderClient, tokenManager }),
          createSendFoa1DomainTransferTool({ client: openproviderClient, tokenManager }),
          createDeleteDomainTool({ client: openproviderClient, tokenManager }),
          createRestartDomainOperationTool({ client: openproviderClient, tokenManager }),
          createRenewDomainTool({ client: openproviderClient, tokenManager }),
          createTransferDomainTool({ client: openproviderClient, tokenManager }),
          createTradeDomainTool({ client: openproviderClient, tokenManager }),
          createRestoreDomainTool({ client: openproviderClient, tokenManager }),
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
      devToken: 'never-used-dl-e2e',
      devPrincipal: {
        kind: 'user',
        tenantId: '00000000-0000-0000-0000-000000000000',
        userId: '00000000-0000-0000-0000-000000000000',
        subject: 'dev',
        scopes: [],
        role: 'viewer',
      },
      apiKeyResolver: createApiKeyResolver(pool),
      dispatchFactory,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (pgFixture) await pgFixture.stop();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function initSession(bearer: string): Promise<string> {
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
          clientInfo: { name: 'dl-e2e', version: '0' },
        },
      }),
    });
    expect(r.status).toBe(200);
    const sid = r.headers.get('mcp-session-id');
    if (!sid) throw new Error('initialize did not return Mcp-Session-Id');
    return sid;
  }

  async function callTool(
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

  // ---------------------------------------------------------------------------
  // 1. tools/list includes all 11 new tool names
  // ---------------------------------------------------------------------------
  it('tools/list includes all 11 new domain-lifecycle tool names', () => {
    const catalog = buildToolCatalog();
    const names = catalog.map((t) => t.name);
    const expected = [
      'suggest_domain',
      'get_domain_authcode',
      'reset_domain_authcode',
      'approve_domain_transfer',
      'send_foa1_domain_transfer',
      'delete_domain',
      'restart_domain_operation',
      'renew_domain',
      'transfer_domain',
      'trade_domain',
      'restore_domain',
    ];
    for (const name of expected) {
      expect(names, `expected tool "${name}" to be in catalog`).toContain(name);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. allow-mode read tool reaches handler → not-connected (no OP creds)
  //    suggest_domain is allow-mode (suggest_* wildcard in DEFAULT_POLICY)
  // ---------------------------------------------------------------------------
  it('operator calling suggest_domain (allow-mode) reaches handler → openprovider_not_connected', async () => {
    const sid = await initSession(operatorKey);
    const body = (await callTool(sid, operatorKey, 'suggest_domain', { name: 'example' })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    // Handler throws OpenproviderAccountNotConnected (code = 'openprovider_not_connected').
    // Transport surfaces it as: error.data.code === 'openprovider_not_connected'
    expect(
      body.error?.data?.code === 'openprovider_not_connected' ||
        (body.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(body).toLowerCase().includes('not_connected'),
      'suggest_domain should fail with openprovider_not_connected, got: ' + JSON.stringify(body),
    ).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 3. confirm-mode tool short-circuits → propose result (confirmation_required shape)
  //    renew_domain is confirm-mode in DEFAULT_POLICY
  //    Tenant has no OP creds, but pricing returns 0 for non-billable tools,
  //    and the spend cap check passes at €0 cost with a €0 cap (propose succeeds).
  // ---------------------------------------------------------------------------
  it('operator calling renew_domain (confirm-mode) → confirmation proposed, not executed', async () => {
    const sid = await initSession(operatorKey);
    const body = (await callTool(sid, operatorKey, 'renew_domain', {
      id: 1,
      period: 1,
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    // confirm-mode with no token → dispatcher calls propose → returns ProposeResult
    // The transport wraps it in result.content[0].text (not an error).
    const text = body.result?.content[0]?.text;
    expect(
      text,
      'renew_domain should return a confirmation proposal (result.content[0].text), got: ' +
        JSON.stringify(body),
    ).toBeDefined();

    const proposed = JSON.parse(text ?? '{}') as {
      confirmationId?: string;
      confirmationToken?: string;
      summary?: string;
      expiresAt?: string;
      requiredApproverRoles?: string[];
    };
    expect(proposed.confirmationId, 'confirmationId must be present').toBeTruthy();
    expect(proposed.confirmationToken).toBe(proposed.confirmationId);
    expect(proposed.expiresAt).toBeTruthy();
    expect(Array.isArray(proposed.requiredApproverRoles)).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 4a. viewer write-gate: viewer calling delete_domain (confirm-mode, non-read)
  //     → policy_denied
  // ---------------------------------------------------------------------------
  it('viewer calling delete_domain (confirm-mode write) → policy_denied', async () => {
    const sid = await initSession(viewerKey);
    const body = (await callTool(sid, viewerKey, 'delete_domain', { id: 1 })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    expect(
      body.error,
      'viewer calling delete_domain should be denied, got: ' + JSON.stringify(body),
    ).toBeDefined();
    expect(body.error?.data?.code).toBe('policy_denied');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 4b. viewer read-gate: viewer calling suggest_domain (allow-mode, read tool)
  //     → allowed, reaches handler → not-connected (same as operator path)
  // ---------------------------------------------------------------------------
  it('viewer calling suggest_domain (allow-mode read) → allowed, reaches handler → openprovider_not_connected', async () => {
    const sid = await initSession(viewerKey);
    const body = (await callTool(sid, viewerKey, 'suggest_domain', { name: 'example' })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    // Viewer can call allow-mode read tools; it reaches the handler which throws not-connected.
    expect(
      body.error?.data?.code === 'openprovider_not_connected' ||
        (body.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(body).toLowerCase().includes('not_connected'),
      'viewer calling suggest_domain should reach handler and fail with openprovider_not_connected, got: ' +
        JSON.stringify(body),
    ).toBe(true);
  }, 60_000);
});

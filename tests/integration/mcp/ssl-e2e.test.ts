/**
 * SSL dispatch + policy integration test (Phase — batch 4).
 *
 * Proves that the 15 SSL/CSR tools are wired into the dispatcher and
 * that DEFAULT_POLICY modes (allow vs confirm) and the viewer write-gate
 * behave correctly end-to-end through the real HTTP stack, without making
 * real Openprovider network calls.
 *
 * Mirrors catalog-tags-e2e.test.ts exactly:
 *   - same 120_000 beforeAll timeout
 *   - defensive afterAll (pool?.end() then fixture?.stop())
 *   - seedTenantOwner + issueApiKey for principal provisioning
 *   - full ConfirmDeps wired with DEFAULT_POLICY tools map
 *   - operator key (mcp:read + mcp:write) → resolves to 'operator' callerRole
 *   - viewer  key (mcp:read only)         → resolves to 'viewer'  callerRole
 *
 * Tool policy modes from DEFAULT_POLICY:
 *   Reads  (allow via list_ and get_ wildcards):
 *     list_ssl_products, get_ssl_product, list_ssl_orders, get_ssl_order,
 *     get_ssl_approver_emails
 *   Allow-writes (explicit allow entries):
 *     update_ssl_order, update_ssl_approver_email, resend_ssl_approver_email,
 *     create_csr, decode_csr, create_ssl_otp_token
 *   Confirms:
 *     create_ssl_order, renew_ssl_order, reissue_ssl_order, cancel_ssl_order
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
import { requiredApproverRoles, type Role } from '../../../src/policies/schema.js';
import { centsToEur } from '../../../src/policies/money.js';
import { createListPendingConfirmationsTool } from '../../../src/tools/list-pending-confirmations.js';
import { createConfirmPendingTool } from '../../../src/tools/confirm-pending.js';
import { claimConfirmation, unclaimConfirmation } from '../../../src/policies/idempotency.js';
import type { LoadedConfirmation } from '../../../src/policies/repo.js';
import { createPricing, DRIFT_TOLERANCE } from '../../../src/policies/pricing.js';

// Also needed for tools/list via buildToolCatalog.
import { buildToolCatalog } from '../../../src/mcp/tool-catalog.js';

// The 15 SSL/CSR tools.
import { createListSslProductsTool } from '../../../src/tools/list-ssl-products.js';
import { createGetSslProductTool } from '../../../src/tools/get-ssl-product.js';
import { createListSslOrdersTool } from '../../../src/tools/list-ssl-orders.js';
import { createGetSslOrderTool } from '../../../src/tools/get-ssl-order.js';
import { createGetSslApproverEmailsTool } from '../../../src/tools/get-ssl-approver-emails.js';
import { createUpdateSslOrderTool } from '../../../src/tools/update-ssl-order.js';
import { createUpdateSslApproverEmailTool } from '../../../src/tools/update-ssl-approver-email.js';
import { createResendSslApproverEmailTool } from '../../../src/tools/resend-ssl-approver-email.js';
import { createCreateCsrTool } from '../../../src/tools/create-csr.js';
import { createDecodeCsrTool } from '../../../src/tools/decode-csr.js';
import { createCreateSslOtpTokenTool } from '../../../src/tools/create-ssl-otp-token.js';
import { createCreateSslOrderTool } from '../../../src/tools/create-ssl-order.js';
import { createRenewSslOrderTool } from '../../../src/tools/renew-ssl-order.js';
import { createReissueSslOrderTool } from '../../../src/tools/reissue-ssl-order.js';
import { createCancelSslOrderTool } from '../../../src/tools/cancel-ssl-order.js';

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

describe('SSL dispatch + policy e2e', () => {
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
    const seeded = await seedTenantOwner(pool, 'ssl-e2e@example.com', 'x-hash-ssl');
    const tenantId = seeded.tenant_id;

    operatorKey = await issueTenantKey(pool, tenantId, 'ssl-operator-key', [
      'mcp:read',
      'mcp:write',
    ]);
    viewerKey = await issueTenantKey(pool, tenantId, 'ssl-viewer-key', ['mcp:read']);

    const openproviderClient = createOpenproviderClient();

    // dispatchFactory mirrors server.ts wiring exactly, including:
    //   - resolveToolMode (role-aware, viewer gate)
    //   - real ConfirmDeps + propose/consume/settle
    //   - all 15 SSL/CSR tools
    //   - no real OP creds so tools will throw not-connected
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
          // 5 allow reads (covered by list_* / get_* wildcards in DEFAULT_POLICY)
          createListSslProductsTool({ client: openproviderClient, tokenManager }),
          createGetSslProductTool({ client: openproviderClient, tokenManager }),
          createListSslOrdersTool({ client: openproviderClient, tokenManager }),
          createGetSslOrderTool({ client: openproviderClient, tokenManager }),
          createGetSslApproverEmailsTool({ client: openproviderClient, tokenManager }),
          // 6 allow writes (explicit allow entries in DEFAULT_POLICY)
          createUpdateSslOrderTool({ client: openproviderClient, tokenManager }),
          createUpdateSslApproverEmailTool({ client: openproviderClient, tokenManager }),
          createResendSslApproverEmailTool({ client: openproviderClient, tokenManager }),
          createCreateCsrTool({ client: openproviderClient, tokenManager }),
          createDecodeCsrTool({ client: openproviderClient, tokenManager }),
          createCreateSslOtpTokenTool({ client: openproviderClient, tokenManager }),
          // 4 confirm writes
          createCreateSslOrderTool({ client: openproviderClient, tokenManager }),
          createRenewSslOrderTool({ client: openproviderClient, tokenManager }),
          createReissueSslOrderTool({ client: openproviderClient, tokenManager }),
          createCancelSslOrderTool({ client: openproviderClient, tokenManager }),
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
      devToken: 'never-used-ssl-e2e',
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
          clientInfo: { name: 'ssl-e2e', version: '0' },
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
  // 1. tools/list / catalog includes all 15 SSL tool names
  // ---------------------------------------------------------------------------
  it('tools/list includes all 15 SSL/CSR tool names', () => {
    const catalog = buildToolCatalog();
    const names = catalog.map((t) => t.name);
    const expected = [
      'list_ssl_products',
      'get_ssl_product',
      'list_ssl_orders',
      'get_ssl_order',
      'get_ssl_approver_emails',
      'update_ssl_order',
      'update_ssl_approver_email',
      'resend_ssl_approver_email',
      'create_csr',
      'decode_csr',
      'create_ssl_otp_token',
      'create_ssl_order',
      'renew_ssl_order',
      'reissue_ssl_order',
      'cancel_ssl_order',
    ];
    for (const name of expected) {
      expect(names, `expected tool "${name}" to be in catalog`).toContain(name);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Allow read (no args) reaches handler → not-connected
  //    list_ssl_products is allow-mode via list_* wildcard in DEFAULT_POLICY
  // ---------------------------------------------------------------------------
  it('operator calling list_ssl_products (allow-mode read, no args) reaches handler → openprovider_not_connected', async () => {
    const sid = await initSession(operatorKey);
    const body = (await callTool(sid, operatorKey, 'list_ssl_products', {})) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    expect(
      body.error?.data?.code === 'openprovider_not_connected' ||
        (body.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(body).toLowerCase().includes('not_connected'),
      'list_ssl_products should fail with openprovider_not_connected, got: ' + JSON.stringify(body),
    ).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 3. Allow read with query arg reaches handler → not-connected
  //    get_ssl_approver_emails is allow-mode via get_* wildcard
  // ---------------------------------------------------------------------------
  it('operator calling get_ssl_approver_emails (allow-mode read, with args) reaches handler → openprovider_not_connected', async () => {
    const sid = await initSession(operatorKey);
    const body = (await callTool(sid, operatorKey, 'get_ssl_approver_emails', {
      domain: 'x.com',
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    expect(
      body.error?.data?.code === 'openprovider_not_connected' ||
        (body.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(body).toLowerCase().includes('not_connected'),
      'get_ssl_approver_emails should fail with openprovider_not_connected, got: ' +
        JSON.stringify(body),
    ).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 4. Allow write reaches handler → not-connected (proves allow, no confirm)
  //    create_csr is allow-mode (explicit entry in DEFAULT_POLICY)
  // ---------------------------------------------------------------------------
  it('operator calling create_csr (allow-mode write) reaches handler → openprovider_not_connected', async () => {
    const sid = await initSession(operatorKey);
    const body = (await callTool(sid, operatorKey, 'create_csr', {
      bits: 2048,
      common_name: 'x.com',
      country: 'NL',
      email: 'a@b.c',
      locality: 'Amsterdam',
      organization: 'X',
      signature_hash_algorithm: 'sha2',
      state: 'NH',
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    // allow-mode — dispatch calls handler directly (no confirm), which throws not-connected
    expect(
      body.error?.data?.code === 'openprovider_not_connected' ||
        (body.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(body).toLowerCase().includes('not_connected'),
      'create_csr should fail with openprovider_not_connected (no confirm), got: ' +
        JSON.stringify(body),
    ).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 5. Confirm short-circuits → proposal shape returned; tool NOT executed
  //    cancel_ssl_order is confirm-mode (explicit entry in DEFAULT_POLICY)
  // ---------------------------------------------------------------------------
  it('operator calling cancel_ssl_order (confirm-mode) → confirmation proposed, not executed', async () => {
    const sid = await initSession(operatorKey);
    const body = (await callTool(sid, operatorKey, 'cancel_ssl_order', {
      id: 1,
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    // confirm-mode with no token → dispatcher calls propose → returns ProposeResult
    // The transport wraps it in result.content[0].text (not an error).
    const text = body.result?.content[0]?.text;
    expect(
      text,
      'cancel_ssl_order should return a confirmation proposal (result.content[0].text), got: ' +
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
  // 6a. Viewer write-gate: viewer calling cancel_ssl_order (confirm-mode, non-read)
  //     → policy_denied
  // ---------------------------------------------------------------------------
  it('viewer calling cancel_ssl_order (confirm-mode write) → policy_denied', async () => {
    const sid = await initSession(viewerKey);
    const body = (await callTool(sid, viewerKey, 'cancel_ssl_order', {
      id: 1,
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    expect(
      body.error,
      'viewer calling cancel_ssl_order should be denied, got: ' + JSON.stringify(body),
    ).toBeDefined();
    expect(body.error?.data?.code).toBe('policy_denied');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 6b. Viewer write-gate: viewer calling create_csr (allow-mode write)
  //     → policy_denied
  // ---------------------------------------------------------------------------
  it('viewer calling create_csr (allow-mode write) → policy_denied', async () => {
    const sid = await initSession(viewerKey);
    const body = (await callTool(sid, viewerKey, 'create_csr', {
      bits: 2048,
      common_name: 'x.com',
      country: 'NL',
      email: 'a@b.c',
      locality: 'Amsterdam',
      organization: 'X',
      signature_hash_algorithm: 'sha2',
      state: 'NH',
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    expect(
      body.error,
      'viewer calling create_csr should be denied, got: ' + JSON.stringify(body),
    ).toBeDefined();
    expect(body.error?.data?.code).toBe('policy_denied');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 6c. Viewer read-gate: viewer calling list_ssl_products (allow-mode read)
  //     → allowed, reaches handler → not-connected (same as operator path)
  // ---------------------------------------------------------------------------
  it('viewer calling list_ssl_products (allow-mode read) → allowed, reaches handler → openprovider_not_connected', async () => {
    const sid = await initSession(viewerKey);
    const body = (await callTool(sid, viewerKey, 'list_ssl_products', {})) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    // Viewer can call allow-mode read tools; it reaches the handler which throws not-connected.
    expect(
      body.error?.data?.code === 'openprovider_not_connected' ||
        (body.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(body).toLowerCase().includes('not_connected'),
      'viewer calling list_ssl_products should reach handler and fail with openprovider_not_connected, got: ' +
        JSON.stringify(body),
    ).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 6d. Viewer read-gate: viewer calling get_ssl_approver_emails (allow-mode read)
  //     → allowed, reaches handler → not-connected
  // ---------------------------------------------------------------------------
  it('viewer calling get_ssl_approver_emails (allow-mode read) → allowed, reaches handler → openprovider_not_connected', async () => {
    const sid = await initSession(viewerKey);
    const body = (await callTool(sid, viewerKey, 'get_ssl_approver_emails', {
      domain: 'x.com',
    })) as {
      result?: { content: { text: string }[] };
      error?: { message: string; data?: { code?: string } };
    };

    expect(
      body.error?.data?.code === 'openprovider_not_connected' ||
        (body.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(body).toLowerCase().includes('not_connected'),
      'viewer calling get_ssl_approver_emails should reach handler and fail with openprovider_not_connected, got: ' +
        JSON.stringify(body),
    ).toBe(true);
  }, 60_000);
});

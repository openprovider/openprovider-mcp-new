import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import nock from 'nock';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createFakeJwks, type FakeJwks } from '../_helpers/fake-jwks.js';
import { issueApiKey, createApiKeyResolver } from '../../../src/auth/api-key.js';

import { createMcpServer } from '../../../src/mcp/transport.js';
import { createWorkOsVerifier } from '../../../src/auth/oauth/workos.js';
import { createTenantResolver } from '../../../src/auth/tenant-resolver.js';
import { createFakeKms } from '../../../src/secrets/fake-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import {
  createDispatcher,
  type ConfirmDeps,
  type DispatcherTool,
} from '../../../src/mcp/dispatch.js';
import { createPgAuditSink } from '../../../src/audit/pg-sink.js';
import { createCheckDomainTool } from '../../../src/tools/check-domain.js';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';
import { createOpenproviderTokenManager } from '../../../src/openprovider/token-manager.js';
import { createPgTokenCache } from '../../../src/openprovider/token-cache-pg.js';
import { OpenproviderAccountNotConnected } from '../../../src/openprovider/errors.js';
import type { Principal } from '../../../src/auth/principal.js';

// Phase 4 imports
import {
  getPolicy,
  upsertPolicy,
  liveSpendCents,
  proposeConfirmation,
  loadConfirmation,
  settleConfirmation,
  canonicalArgsHash,
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

// Phase 5 imports
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

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b1';

// oauth_subject values seeded into users rows for scenarios 1-2.
const SUB_TENANT_A = 'sub_tenant_a';
const SUB_TENANT_B = 'sub_tenant_b';

describe('phase 2 end-to-end', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;
  let jwks: FakeJwks;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    // Boot infra in parallel.
    [pgFixture, jwks] = await Promise.all([startPostgres(), createFakeJwks()]);
    jwks.install();

    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    // Seed two tenants, each with an Openprovider account row and encrypted password.
    const kms = createFakeKms();

    // Insert tenants, openprovider_accounts, and users as superuser (bypasses RLS).
    // The users rows link each oauth_subject to the correct pre-seeded tenant so that
    // resolve_or_provision_tenant returns TENANT_A/TENANT_B (not a fresh auto-provisioned tenant)
    // when scenarios 1-2 tokens are verified.
    const seedClient = await pool.connect();
    try {
      await seedClient.query(
        `INSERT INTO tenants (id, name) VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`,
        [TENANT_A, TENANT_B],
      );
      await seedClient.query(
        `INSERT INTO openprovider_accounts (tenant_id, username)
         VALUES ($1, 'user-a'), ($2, 'user-b')`,
        [TENANT_A, TENANT_B],
      );
      // Seed users rows so resolve_or_provision_tenant finds the existing tenant.
      await seedClient.query(
        `INSERT INTO users (tenant_id, email, oauth_subject, role)
         VALUES ($1, 'a@example.com', $3, 'owner'),
                ($2, 'b@example.com', $4, 'owner')`,
        [TENANT_A, TENANT_B, SUB_TENANT_A, SUB_TENANT_B],
      );
    } finally {
      seedClient.release();
    }

    // Encrypt and store each tenant's openprovider.password via RLS context.
    for (const t of [TENANT_A, TENANT_B] as const) {
      await runAsTenant(pool, t, async (client) => {
        const store = createSecretsStore({
          kms,
          kmsKeyArn: 'fake-key',
          repo: createDbSecretsRepo(client),
        });
        await store.put(t, 'openprovider.password', Buffer.from(`pw-${t.slice(-1)}`));
      });
    }

    // Build the dispatchFactory.
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

    const verifier = createWorkOsVerifier({
      clientId: jwks.audience,
      issuer: jwks.issuer,
      jwksUri: jwks.jwksUri,
    });

    app = await createMcpServer({
      devToken: 'never-used-in-this-test',
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
    if (app) await app.close();
    if (pool) await pool.end();
    if (pgFixture) await pgFixture.stop();
    nock.cleanAll();
  });

  function mockOpenproviderLogin(token: string) {
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .reply(200, { data: { token, reseller_id: 1 } });
  }

  function mockCheckDomain(domain: string) {
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(200, { data: { results: [{ domain, status: 'free' }] } });
  }

  /**
   * Initialize an MCP session and return its Mcp-Session-Id. This handshake is required
   * because StreamableHTTPServerTransport rejects POST without it.
   */
  async function initializeSession(bearer: string): Promise<string> {
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
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(r.status).toBe(200);
    const sid = r.headers.get('mcp-session-id');
    if (!sid) throw new Error('initialize did not return Mcp-Session-Id');
    return sid;
  }

  async function callTool(sid: string, bearer: string, args: unknown): Promise<unknown> {
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
        params: { name: 'check_domain', arguments: args },
      }),
    });
    const text = await r.text();
    // Response may be SSE (data: {...}) or plain JSON.
    const jsonLine = text.includes('data:')
      ? text
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5)
          .trim()
      : text;
    return JSON.parse(jsonLine) as unknown;
  }

  it('scenario 1: tenant A check_domain happy path with audit row', async () => {
    mockOpenproviderLogin('jwt-a');
    mockCheckDomain('a.com');

    // Token uses sub that maps to TENANT_A via the seeded users row.
    const bearer = await jwks.mintToken({ sub: SUB_TENANT_A, email: 'a@example.com' });

    const sid = await initializeSession(bearer);
    const body = (await callTool(sid, bearer, {
      domains: [{ name: 'a', extension: 'com' }],
      with_price: false,
    })) as { result?: { content: { text: string }[] } };

    const innerText = body.result?.content[0]?.text;
    expect(innerText).toBeDefined();
    const parsed = JSON.parse(innerText ?? '{}') as { results: { domain: string }[] };
    expect(parsed.results[0]?.domain).toBe('a.com');

    // Audit row landed in tenant A's slice.
    const rows = await runAsTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ tool_name: string }>(
        `SELECT tool_name FROM audit_events WHERE event_type = 'tool.result'`,
      );
      return r.rows;
    });
    expect(rows.some((r) => r.tool_name === 'check_domain')).toBe(true);
  }, 60_000);

  it('scenario 2: tenant B sees only its own audit rows under RLS', async () => {
    mockOpenproviderLogin('jwt-b');
    mockCheckDomain('b.com');

    // Token uses sub that maps to TENANT_B via the seeded users row.
    const bearer = await jwks.mintToken({ sub: SUB_TENANT_B, email: 'b@example.com' });

    const sid = await initializeSession(bearer);
    const body = (await callTool(sid, bearer, {
      domains: [{ name: 'b', extension: 'com' }],
      with_price: false,
    })) as { result?: { content: { text: string }[] } };

    const innerText = body.result?.content[0]?.text;
    const parsed = JSON.parse(innerText ?? '{}') as { results: { domain: string }[] };
    expect(parsed.results[0]?.domain).toBe('b.com');

    const rowsB = await runAsTenant(pool, TENANT_B, async (c) => {
      const r = await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM audit_events`);
      return r.rows;
    });
    // Should contain at least one row (its own).
    expect(rowsB.length).toBeGreaterThan(0);
    // Every row visible to tenant B must belong to tenant B.
    expect(rowsB.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    // And NONE of them should be tenant A's.
    expect(rowsB.some((r) => r.tenant_id === TENANT_A)).toBe(false);
  }, 60_000);

  it('scenario 3: invalid bearer returns 401', async () => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer this-is-not-a-real-jwt',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(r.status).toBe(401);
  }, 30_000);

  it('scenario 4: missing bearer returns 401', async () => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(r.status).toBe(401);
  }, 30_000);

  it('scenario 5: real-shaped token auto-provisions a tenant; check_domain reports not-connected, then succeeds after onboard', async () => {
    const kms = createFakeKms();

    // Mint a token with ONLY sub + email — no act.tnt, no mcp:* scopes.
    const bearer = await jwks.mintToken({ sub: 'auto_user_1', email: 'auto1@example.com' });

    // Initialize session — this triggers resolve_or_provision_tenant, creating the tenant.
    const sid = await initializeSession(bearer);

    // First call: tenant was auto-provisioned but has no Openprovider creds yet.
    const notConnected = (await callTool(sid, bearer, {
      domains: [{ name: 'auto', extension: 'com' }],
      with_price: false,
    })) as { error?: { message: string; data?: { code?: string } } };

    // The transport surfaces the error as a JSON-RPC error with data.code.
    expect(
      notConnected.error?.data?.code === 'openprovider_not_connected' ||
        (notConnected.error?.message ?? '').toLowerCase().includes('not connected') ||
        JSON.stringify(notConnected).toLowerCase().includes('not_connected'),
    ).toBe(true);

    // Resolve the auto-provisioned tenant id using the SECURITY DEFINER fn.
    const resolverClient = await pool.connect();
    let tenantId: string;
    try {
      await resolverClient.query('SET ROLE app_role');
      const r = await resolverClient.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1, $2)',
        ['auto_user_1', 'auto1@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
    } finally {
      resolverClient.release();
    }

    expect(tenantId).toBeTruthy();

    // Onboard credentials the same way the CLI (tenant:onboard) does.
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO openprovider_accounts (tenant_id, username) VALUES ($1, 'auto-op-user')
           ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username`,
        [tenantId],
      );
      const store = createSecretsStore({
        kms,
        kmsKeyArn: 'fake-key',
        repo: createDbSecretsRepo(client),
      });
      await store.put(tenantId, 'openprovider.password', Buffer.from('auto-pw'));
    });

    // Mock Openprovider login + check for the second call.
    mockOpenproviderLogin('jwt-auto');
    mockCheckDomain('auto.com');

    // New session so the token manager picks up the freshly onboarded creds.
    const sid2 = await initializeSession(bearer);
    const ok = (await callTool(sid2, bearer, {
      domains: [{ name: 'auto', extension: 'com' }],
      with_price: false,
    })) as { result?: { content: { text: string }[] } };

    const innerText = ok.result?.content[0]?.text;
    expect(innerText).toBeDefined();
    const inner = JSON.parse(innerText ?? '{}') as { results: { domain: string }[] };
    expect(inner.results[0]?.domain).toBe('auto.com');
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Phase 4: synthetic confirm tool — propose → confirm_pending → committed
  // ---------------------------------------------------------------------------
  describe('phase 4: confirm flow', () => {
    let p4App: FastifyInstance;
    let p4BaseUrl: string;

    // Synthetic tool: priced at a fixed 1500 cents (€15) by the test pricer.
    const phase4SpendTool: DispatcherTool = {
      name: 'phase4.spend',
      description: 'Synthetic billable tool for Phase 4 e2e testing.',
      inputSchema: z.object({ note: z.string().default('x') }),
      handler: () => Promise.resolve({ spent: true }),
    };

    // Fixed pricer: returns 1500 cents for phase4.spend, 0 for everything else.
    const fixedPricer = {
      price: async (toolName: string): Promise<number> => {
        if (toolName === 'phase4.spend') return 1500;
        return 0;
      },
    };

    const CONFIRM_TTL_MS = 5 * 60 * 1000;

    beforeAll(async () => {
      // Build a dispatchFactory that mirrors server.ts but:
      //   - registers phase4.spend (synthetic)
      //   - uses fixedPricer (no Openprovider upstream needed)
      //   - policy tools map includes 'phase4.spend':'confirm'
      async function p4DispatchFactory(principal: Principal) {
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

          // Shared validation helper (mirrors server.ts validateConfirmation)
          const validateConfirmation = async (
            token: string,
            args: unknown,
            p: Principal,
          ): Promise<
            { kind: 'error'; code: string } | { kind: 'ok'; conf: LoadedConfirmation }
          > => {
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
            // Re-price with fixed pricer (no drift possible in tests)
            const fresh = await fixedPricer.price(conf.toolName);
            if (fresh > Math.round(conf.estimatedCostCents * 1.05)) {
              await settleConfirmation(client, conf.id, 'released');
              return { kind: 'error', code: 'price_changed' };
            }
            return { kind: 'ok', conf };
          };

          // Meta-tools bypass the policy gate (same fix as src/server.ts).
          const META_TOOLS = new Set(['confirm_pending', 'list_pending_confirmations']);

          // ConfirmDeps wired with fixedPricer
          const confirm: ConfirmDeps = {
            resolveMode: async (toolName) => {
              if (META_TOOLS.has(toolName)) return 'allow';
              const policy = await getPolicy(client, principal.tenantId);
              return toolMode(policy, toolName);
            },

            propose: async ({ toolName, args, principal: p }) => {
              // Serialize on the policy row
              await client.query('SELECT 1 FROM policies WHERE tenant_id = $1 FOR UPDATE', [
                p.tenantId,
              ]);
              const policy = await getPolicy(client, p.tenantId);
              const live = await liveSpendCents(client, p.tenantId);
              const estimatedCostCents = await fixedPricer.price(toolName);
              const callerRole: Role = p.kind === 'user' ? p.role : 'viewer';
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
              return { kind: 'ok', confirmationId: validated.conf.id };
            },

            settle: async (confirmationId, outcome) => {
              await settleConfirmation(client, confirmationId, outcome);
            },
          };

          // Base tools + list_pending_confirmations
          const tools: DispatcherTool[] = [
            phase4SpendTool,
            createListPendingConfirmationsTool({ getClient: () => client }),
          ];

          // confirm_pending — Path 2: validates + executes the original tool
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
            try {
              const result = await originalTool.handler(input.args, input.principal);
              await settleConfirmation(client, conf.id, 'committed');
              return { kind: 'ok', result };
            } catch (err) {
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

      p4App = await createMcpServer({
        devToken: 'never-used-p4',
        devPrincipal: {
          kind: 'user',
          tenantId: '00000000-0000-0000-0000-000000000000',
          userId: '00000000-0000-0000-0000-000000000000',
          subject: 'dev',
          scopes: [],
          role: 'viewer',
        },
        verifier: createWorkOsVerifier({
          clientId: jwks.audience,
          issuer: jwks.issuer,
          jwksUri: jwks.jwksUri,
        }),
        resolveTenant: createTenantResolver(pool),
        dispatchFactory: p4DispatchFactory,
      });
      await p4App.listen({ host: '127.0.0.1', port: 0 });
      const addr = p4App.server.address() as AddressInfo;
      p4BaseUrl = `http://127.0.0.1:${addr.port}`;
    }, 120_000);

    afterAll(async () => {
      if (p4App) await p4App.close();
    });

    /**
     * Initialize an MCP session on the Phase 4 server.
     */
    async function p4InitSession(bearer: string): Promise<string> {
      const r = await fetch(`${p4BaseUrl}/mcp`, {
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
            clientInfo: { name: 'e2e-p4', version: '0' },
          },
        }),
      });
      expect(r.status).toBe(200);
      const sid = r.headers.get('mcp-session-id');
      if (!sid) throw new Error('p4 initialize did not return Mcp-Session-Id');
      return sid;
    }

    /**
     * Call any named tool on the Phase 4 server.
     */
    async function p4CallTool(
      sid: string,
      bearer: string,
      toolName: string,
      toolArgs: unknown,
    ): Promise<unknown> {
      const r = await fetch(`${p4BaseUrl}/mcp`, {
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

    /**
     * Provision a fresh tenant via auto-provisioning (real-shaped JWT with sub+email),
     * upsert its policy to the given doc, and return { tenantId, bearer }.
     */
    async function provisionTenant(
      sub: string,
      email: string,
      limitEur: number,
    ): Promise<{ tenantId: string; bearer: string; sid: string }> {
      const bearer = await jwks.mintToken({ sub, email });
      // Initialize a session — this triggers resolve_or_provision_tenant.
      const sid = await p4InitSession(bearer);

      // Resolve the provisioned tenant id via the SECURITY DEFINER fn.
      const resolverClient = await pool.connect();
      let tenantId: string;
      try {
        await resolverClient.query('SET ROLE app_role');
        const r = await resolverClient.query<{ tenant_id: string }>(
          'SELECT * FROM resolve_or_provision_tenant($1, $2)',
          [sub, email],
        );
        tenantId = r.rows[0]!.tenant_id;
      } finally {
        resolverClient.release();
      }

      // Raise spend cap and add phase4.spend to the policy's tools map.
      await runAsTenant(pool, tenantId, async (c) => {
        await upsertPolicy(c, tenantId, {
          ...DEFAULT_POLICY,
          spend_caps: { window: 'month', limit_eur: limitEur },
          tools: {
            ...DEFAULT_POLICY.tools,
            'phase4.spend': 'confirm',
          },
        });
      });

      return { tenantId, bearer, sid };
    }

    it('scenario P4-a/b/c: propose → confirm_pending → committed; live spend = 1500', async () => {
      const { tenantId, bearer, sid } = await provisionTenant('p4_user_1', 'p4_1@example.com', 100);

      // (a) Propose phase4.spend — no confirm token → confirmation_required
      const proposeBody = (await p4CallTool(sid, bearer, 'phase4.spend', { note: 'x' })) as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      // The dispatcher returns the propose result wrapped in MCP result.content[0].text
      const proposeText = proposeBody.result?.content[0]?.text;
      expect(
        proposeText,
        'propose should return a result, not error: ' + JSON.stringify(proposeBody),
      ).toBeDefined();
      const proposeResult = JSON.parse(proposeText ?? '{}') as {
        confirmationId?: string;
        confirmationToken?: string;
        summary?: string;
        estimatedCostEur?: number;
      };
      expect(proposeResult.confirmationId, 'confirmationId must be present').toBeTruthy();
      expect(proposeResult.confirmationToken).toBe(proposeResult.confirmationId);
      expect(proposeResult.estimatedCostEur).toBe(15); // 1500 cents = €15

      const confirmationId = proposeResult.confirmationId!;

      // (b) Call confirm_pending with that id — args must match what was proposed
      // The dispatcher stored hash of zod-parsed args = { note: 'x' }
      const sid2 = await p4InitSession(bearer); // fresh session for the confirm call
      const confirmBody = (await p4CallTool(sid2, bearer, 'confirm_pending', {
        confirmation_id: confirmationId,
        args: { note: 'x' },
      })) as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      const confirmText = confirmBody.result?.content[0]?.text;
      expect(
        confirmText,
        'confirm_pending should succeed, got: ' + JSON.stringify(confirmBody),
      ).toBeDefined();
      const confirmResult = JSON.parse(confirmText ?? '{}') as { spent?: boolean };
      expect(confirmResult.spent).toBe(true);

      // (c) Verify live spend = 1500 cents and reservation is committed
      await runAsTenant(pool, tenantId, async (c) => {
        const spendCents = await liveSpendCents(c, tenantId);
        expect(spendCents).toBe(1500);

        // Check the reservation is committed
        const r = await c.query<{ status: string }>(
          `SELECT sr.status FROM spend_reservations sr
             JOIN confirmations co ON co.id = sr.confirmation_id
             WHERE co.id = $1`,
          [confirmationId],
        );
        expect(r.rows[0]?.status).toBe('committed');
      });
    }, 90_000);

    it('scenario P4-d: 7th proposal denied — cap exceeded (6×€15=€90 ≤ €100; 7th pushes to €105)', async () => {
      // Fresh tenant at €100 cap
      const { tenantId, bearer } = await provisionTenant('p4_user_2', 'p4_2@example.com', 100);

      // Propose 6 times — all should succeed (6×1500=9000 ≤ 10000)
      for (let i = 0; i < 6; i++) {
        const sid = await p4InitSession(bearer);
        const body = (await p4CallTool(sid, bearer, 'phase4.spend', { note: 'x' })) as {
          result?: { content: { text: string }[] };
          error?: { message: string; data?: { code?: string } };
        };
        const text = body.result?.content[0]?.text;
        expect(
          text,
          `proposal ${i + 1} should return confirmation_required, got: ${JSON.stringify(body)}`,
        ).toBeDefined();
        const r = JSON.parse(text ?? '{}') as { confirmationId?: string };
        expect(r.confirmationId, `proposal ${i + 1} should have confirmationId`).toBeTruthy();
      }

      // Verify live spend is now 9000 cents (6 pending reservations)
      await runAsTenant(pool, tenantId, async (c) => {
        expect(await liveSpendCents(c, tenantId)).toBe(9000);
      });

      // 7th proposal → policy_denied (9000 + 1500 = 10500 > 10000)
      const sid7 = await p4InitSession(bearer);
      const body7 = (await p4CallTool(sid7, bearer, 'phase4.spend', { note: 'x' })) as {
        error?: { message: string; data?: { code?: string } };
      };
      expect(
        body7.error,
        '7th proposal should be denied, got: ' + JSON.stringify(body7),
      ).toBeDefined();
      expect(body7.error?.data?.code).toBe('policy_denied');
    }, 120_000);

    it('scenario P4-e: tenant with €0 cap → phase4.spend propose → policy_denied', async () => {
      // Default limit_eur: 0 → any spend is denied
      const { bearer } = await provisionTenant('p4_user_3', 'p4_3@example.com', 0);

      const sid = await p4InitSession(bearer);
      const body = (await p4CallTool(sid, bearer, 'phase4.spend', { note: 'x' })) as {
        error?: { message: string; data?: { code?: string } };
      };
      expect(
        body.error,
        '€0 tenant should get policy_denied, got: ' + JSON.stringify(body),
      ).toBeDefined();
      expect(body.error?.data?.code).toBe('policy_denied');
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Phase 5: real write tools — register_domain + create_contact idempotency
  //          + concurrent-claim marquee
  // ---------------------------------------------------------------------------
  describe('phase 5: write tools + claim machinery', () => {
    let p5App: FastifyInstance;
    let p5BaseUrl: string;

    const CONFIRM_TTL_MS = 5 * 60 * 1000;

    beforeAll(async () => {
      // The p5 dispatchFactory mirrors src/server.ts exactly:
      //   - real write tools (register_domain, create_contact, etc.)
      //   - real createPricing (calls checkDomain for billable tools)
      //   - real claimConfirmation / unclaimConfirmation
      //   - real withIdempotency for create_contact
      async function p5DispatchFactory(principal: Principal) {
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

          const p5OpClient = createOpenproviderClient();
          const pricing = createPricing({ client: p5OpClient });

          const tokenManagerSafeToken = async (tenantId: string): Promise<string> => {
            try {
              return await tokenManager.getToken(tenantId);
            } catch (err) {
              if (err instanceof OpenproviderAccountNotConnected) return '';
              throw err;
            }
          };

          const validateConfirmation = async (
            token: string,
            args: unknown,
            p: Principal,
          ): Promise<
            { kind: 'error'; code: string } | { kind: 'ok'; conf: LoadedConfirmation }
          > => {
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
            client: p5OpClient,
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
            createCheckDomainTool({ client: p5OpClient, tokenManager }),
            createRegisterDomainTool({ client: p5OpClient, tokenManager }),
            createUpdateDomainTool({ client: p5OpClient, tokenManager }),
            wrappedCreateContact,
            createUpdateContactTool({ client: p5OpClient, tokenManager }),
            createDeleteContactTool({ client: p5OpClient, tokenManager }),
            createListPendingConfirmationsTool({ getClient: () => client }),
          ];

          // Path 2: confirm_pending — validates + claims + executes.
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

      p5App = await createMcpServer({
        devToken: 'never-used-p5',
        devPrincipal: {
          kind: 'user',
          tenantId: '00000000-0000-0000-0000-000000000000',
          userId: '00000000-0000-0000-0000-000000000000',
          subject: 'dev',
          scopes: [],
          role: 'viewer',
        },
        verifier: createWorkOsVerifier({
          clientId: jwks.audience,
          issuer: jwks.issuer,
          jwksUri: jwks.jwksUri,
        }),
        resolveTenant: createTenantResolver(pool),
        dispatchFactory: p5DispatchFactory,
      });
      await p5App.listen({ host: '127.0.0.1', port: 0 });
      const addr = p5App.server.address() as AddressInfo;
      p5BaseUrl = `http://127.0.0.1:${addr.port}`;
    }, 120_000);

    afterAll(async () => {
      if (p5App) await p5App.close();
      nock.cleanAll();
    });

    /** Initialize an MCP session on the Phase 5 server. */
    async function p5InitSession(bearer: string): Promise<string> {
      const r = await fetch(`${p5BaseUrl}/mcp`, {
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
            clientInfo: { name: 'e2e-p5', version: '0' },
          },
        }),
      });
      expect(r.status).toBe(200);
      const sid = r.headers.get('mcp-session-id');
      if (!sid) throw new Error('p5 initialize did not return Mcp-Session-Id');
      return sid;
    }

    /** Call any named tool on the Phase 5 server. */
    async function p5CallTool(
      sid: string,
      bearer: string,
      toolName: string,
      toolArgs: unknown,
    ): Promise<unknown> {
      const r = await fetch(`${p5BaseUrl}/mcp`, {
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

    /**
     * Provision a fresh tenant on the p5 server: auto-provision via JWT,
     * seed Openprovider creds, raise the spend cap, and return identifiers.
     */
    async function p5ProvisionTenant(
      sub: string,
      email: string,
      limitEur: number,
    ): Promise<{ tenantId: string; bearer: string; sid: string }> {
      const bearer = await jwks.mintToken({ sub, email });
      const sid = await p5InitSession(bearer);

      // Resolve the auto-provisioned tenant id.
      const resolverClient = await pool.connect();
      let tenantId: string;
      try {
        await resolverClient.query('SET ROLE app_role');
        const r = await resolverClient.query<{ tenant_id: string }>(
          'SELECT * FROM resolve_or_provision_tenant($1, $2)',
          [sub, email],
        );
        tenantId = r.rows[0]!.tenant_id;
      } finally {
        resolverClient.release();
      }

      // Seed Openprovider account row + encrypted password (mirrors scenario 5 onboarding).
      const kmsLocal = createFakeKms();
      await runAsTenant(pool, tenantId, async (c) => {
        await c.query(
          `INSERT INTO openprovider_accounts (tenant_id, username) VALUES ($1, 'op-user-${sub}')
             ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username`,
          [tenantId],
        );
        const store = createSecretsStore({
          kms: kmsLocal,
          kmsKeyArn: 'fake-key',
          repo: createDbSecretsRepo(c),
        });
        await store.put(tenantId, 'openprovider.password', Buffer.from(`pw-${sub}`));

        // Raise spend cap. DEFAULT_POLICY already has register_domain:'confirm'.
        await upsertPolicy(c, tenantId, {
          ...DEFAULT_POLICY,
          spend_caps: { window: 'month', limit_eur: limitEur },
        });
      });

      return { tenantId, bearer, sid };
    }

    // -------------------------------------------------------------------------
    // Scenario 5a: approver register_domain happy path (Nock upstream)
    // -------------------------------------------------------------------------
    it('scenario 5a: register_domain propose → confirm_pending → upstream POST once; live spend = 1299', async () => {
      const { tenantId, bearer, sid } = await p5ProvisionTenant(
        'p5_user_1',
        'p5_1@example.com',
        100,
      );

      // Nock: login (token) + checkDomain for pricing (€12.99/yr) + register (once).
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .reply(200, { data: { token: 'jwt-p5a', reseller_id: 1 } });

      // Pricing calls checkDomain with with_price:true.
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

      // The actual registration — must fire exactly once.
      const registerScope = nock('https://api.openprovider.eu')
        .post('/v1beta/domains')
        .reply(200, { data: { id: 42, status: 'ACT' } });

      // Step 1: Propose register_domain (no confirm token) → confirmation_required.
      // The args we send are the raw args that will be stored as the hash basis.
      const domainArgs = {
        domain: { name: 'example', extension: 'com' },
        period: 1,
        owner_handle: 'OWNER-01',
      };

      const proposeBody = (await p5CallTool(sid, bearer, 'register_domain', domainArgs)) as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      const proposeText = proposeBody.result?.content[0]?.text;
      expect(
        proposeText,
        'propose should return confirmation_required, got: ' + JSON.stringify(proposeBody),
      ).toBeDefined();

      const proposeResult = JSON.parse(proposeText ?? '{}') as {
        confirmationId?: string;
        confirmationToken?: string;
        estimatedCostEur?: number;
      };
      expect(proposeResult.confirmationId, 'confirmationId must be present').toBeTruthy();
      expect(proposeResult.estimatedCostEur).toBe(12.99); // 1299 cents = €12.99
      const confirmationId = proposeResult.confirmationId!;

      // Step 2: confirm_pending — login + re-price checkDomain needed again (pricing cache
      // may be populated from propose; nock the login again in case token cache misses,
      // and another checkDomain in case pricing re-runs during validate).
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .optionally()
        .reply(200, { data: { token: 'jwt-p5a-2', reseller_id: 1 } });

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

      const sid2 = await p5InitSession(bearer);
      const confirmBody = (await p5CallTool(sid2, bearer, 'confirm_pending', {
        confirmation_id: confirmationId,
        // args must produce the same canonical hash as what was proposed.
        // The dispatcher stored hash of the raw domainArgs (not zod-parsed).
        args: domainArgs,
      })) as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      const confirmText = confirmBody.result?.content[0]?.text;
      expect(
        confirmText,
        'confirm_pending should succeed, got: ' + JSON.stringify(confirmBody),
      ).toBeDefined();

      const confirmResult = JSON.parse(confirmText ?? '{}') as { id?: number; status?: string };
      expect(confirmResult.id).toBe(42);

      // Assert exactly ONE POST /v1beta/domains fired.
      expect(
        registerScope.isDone(),
        'POST /v1beta/domains interceptor must have been consumed exactly once',
      ).toBe(true);

      // Assert live spend = 1299 cents.
      await runAsTenant(pool, tenantId, async (c) => {
        const spendCents = await liveSpendCents(c, tenantId);
        expect(spendCents).toBe(1299);

        const r = await c.query<{ status: string }>(
          `SELECT sr.status FROM spend_reservations sr
               JOIN confirmations co ON co.id = sr.confirmation_id
               WHERE co.id = $1`,
          [confirmationId],
        );
        expect(r.rows[0]?.status).toBe('committed');
      });
    }, 120_000);

    // -------------------------------------------------------------------------
    // Scenario 5b: create_contact idempotent replay — upstream POST fires once
    // -------------------------------------------------------------------------
    it('scenario 5b: create_contact called twice with identical args → upstream POST fires once', async () => {
      const { bearer } = await p5ProvisionTenant('p5_user_2', 'p5_2@example.com', 0);

      // Nock: login once + contacts POST once.
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .reply(200, { data: { token: 'jwt-p5b', reseller_id: 1 } });

      // Single interceptor — consuming it twice would leave the second call without
      // an interceptor, causing nock to return a connection error.
      const contactScope = nock('https://api.openprovider.eu')
        .post('/v1beta/contacts')
        .reply(200, { data: { handle: 'CT-XY123' } });

      const contactArgs = {
        name: { first_name: 'Alice', last_name: 'Smith' },
        phone: { country_code: '+1', subscriber_number: '5551234567' },
        address: {
          street: 'Main St',
          number: '1',
          city: 'Testville',
          zipcode: '12345',
          country: 'US',
        },
      };

      // First call — should hit upstream and store in idempotency_records.
      const sid1 = await p5InitSession(bearer);
      const body1 = (await p5CallTool(sid1, bearer, 'create_contact', contactArgs)) as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      const text1 = body1.result?.content[0]?.text;
      expect(
        text1,
        'first create_contact should succeed, got: ' + JSON.stringify(body1),
      ).toBeDefined();
      const result1 = JSON.parse(text1 ?? '{}') as { handle?: string };
      expect(result1.handle).toBe('CT-XY123');

      // First call consumed the Nock interceptor — assert it's done.
      expect(
        contactScope.isDone(),
        'POST /v1beta/contacts interceptor must have been consumed after first call',
      ).toBe(true);

      // Optional second login nock (token cache may have it but be cautious).
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .optionally()
        .reply(200, { data: { token: 'jwt-p5b-2', reseller_id: 1 } });

      // Second call — SAME args, new session. Must replay from idempotency_records,
      // NOT hit upstream (no second contacts interceptor registered).
      const sid2 = await p5InitSession(bearer);
      const body2 = (await p5CallTool(sid2, bearer, 'create_contact', contactArgs)) as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      const text2 = body2.result?.content[0]?.text;
      expect(
        text2,
        'second create_contact (replay) should succeed, got: ' + JSON.stringify(body2),
      ).toBeDefined();
      const result2 = JSON.parse(text2 ?? '{}') as { handle?: string };

      // Same result as first call — replayed from store.
      expect(result2.handle).toBe('CT-XY123');

      // No pending nock interceptors for /contacts — ensures no second upstream call.
      const pending = nock.pendingMocks().filter((m) => m.includes('/contacts'));
      expect(
        pending.length,
        'no pending /contacts interceptors should remain — second call must have replayed',
      ).toBe(0);
    }, 120_000);

    // -------------------------------------------------------------------------
    // Scenario 5c: concurrent-claim marquee — two simultaneous confirm_pending
    //              calls; only one wins the atomic claim; upstream POST fires once
    // -------------------------------------------------------------------------
    it('scenario 5c: concurrent confirm_pending — exactly one wins claim; POST /v1beta/domains fires once', async () => {
      const { bearer } = await p5ProvisionTenant('p5_user_3', 'p5_3@example.com', 100);

      // Nock: login + checkDomain for pricing + ONE registration slot.
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .reply(200, { data: { token: 'jwt-p5c', reseller_id: 1 } });

      nock('https://api.openprovider.eu')
        .post('/v1beta/domains/check')
        .reply(200, {
          data: {
            results: [
              {
                domain: 'concurrent.io',
                status: 'free',
                is_premium: false,
                price: { product: { price: 12.99, currency: 'EUR' } },
              },
            ],
          },
        });

      // Only ONE registration interceptor — the losing concurrent claim must NOT
      // reach upstream; if it did, nock would error with "no match for request".
      const registerScope = nock('https://api.openprovider.eu')
        .post('/v1beta/domains')
        .reply(200, { data: { id: 99, status: 'ACT' } });

      // Propose register_domain once.
      const domainArgs = {
        domain: { name: 'concurrent', extension: 'io' },
        period: 1,
        owner_handle: 'OWNER-02',
      };

      const sidPropose = await p5InitSession(bearer);
      const proposeBody = (await p5CallTool(sidPropose, bearer, 'register_domain', domainArgs)) as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      const proposeText = proposeBody.result?.content[0]?.text;
      expect(
        proposeText,
        'propose should return confirmation_required, got: ' + JSON.stringify(proposeBody),
      ).toBeDefined();
      const proposeResult = JSON.parse(proposeText ?? '{}') as { confirmationId?: string };
      expect(proposeResult.confirmationId).toBeTruthy();
      const confirmationId = proposeResult.confirmationId!;

      // Set up optional nocks for the concurrent confirm calls' re-pricing.
      // Each confirm_pending re-runs validateConfirmation which re-prices.
      // Two callers = up to two logins + two checkDomain calls.
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .times(2)
        .optionally()
        .reply(200, { data: { token: 'jwt-p5c-conf', reseller_id: 1 } });

      nock('https://api.openprovider.eu')
        .post('/v1beta/domains/check')
        .times(2)
        .optionally()
        .reply(200, {
          data: {
            results: [
              {
                domain: 'concurrent.io',
                status: 'free',
                is_premium: false,
                price: { product: { price: 12.99, currency: 'EUR' } },
              },
            ],
          },
        });

      // Initialize two sessions concurrently.
      const [sidA, sidB] = await Promise.all([p5InitSession(bearer), p5InitSession(bearer)]);

      // Fire two concurrent confirm_pending calls with the same confirmationId.
      const [resultA, resultB] = await Promise.all([
        p5CallTool(sidA, bearer, 'confirm_pending', {
          confirmation_id: confirmationId,
          args: domainArgs,
        }),
        p5CallTool(sidB, bearer, 'confirm_pending', {
          confirmation_id: confirmationId,
          args: domainArgs,
        }),
      ]);

      const bodyA = resultA as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };
      const bodyB = resultB as {
        result?: { content: { text: string }[] };
        error?: { message: string; data?: { code?: string } };
      };

      // Exactly one must succeed and one must fail with confirmation_not_found.
      const successes = [bodyA, bodyB].filter((b) => b.result?.content[0]?.text !== undefined);
      const failures = [bodyA, bodyB].filter(
        (b) => b.error?.data?.code === 'confirmation_not_found',
      );

      expect(
        successes.length,
        `Exactly one concurrent confirm_pending should succeed. A: ${JSON.stringify(bodyA)}, B: ${JSON.stringify(bodyB)}`,
      ).toBe(1);
      expect(
        failures.length,
        `Exactly one concurrent confirm_pending should fail with confirmation_not_found. A: ${JSON.stringify(bodyA)}, B: ${JSON.stringify(bodyB)}`,
      ).toBe(1);

      // The winner must have received the upstream registration result.
      const winner = successes[0]!;
      const winnerText = winner.result!.content[0]!.text;
      const winnerResult = JSON.parse(winnerText) as { id?: number };
      expect(winnerResult.id).toBe(99);

      // Assert the POST /v1beta/domains interceptor was consumed exactly once.
      expect(
        registerScope.isDone(),
        'POST /v1beta/domains must have been called exactly once (losing claim must not reach upstream)',
      ).toBe(true);
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Phase 6: API-key auth — op_live_ key authenticates /mcp; revoked → 401
  // ---------------------------------------------------------------------------
  describe('phase 6: API-key auth path', () => {
    let p6App: FastifyInstance;
    let p6BaseUrl: string;
    let tenantP6: string;
    let issuedKey: string;
    let issuedKeyId: string;

    beforeAll(async () => {
      // Provision a tenant via resolve_or_provision_tenant (SECURITY DEFINER) —
      // same pattern as p4/p5 tests; avoids direct INSERT into tenants (which needs RLS context).
      const seedClient = await pool.connect();
      try {
        await seedClient.query('SET ROLE app_role');
        const r = await seedClient.query<{ tenant_id: string }>(
          `SELECT * FROM resolve_or_provision_tenant($1, $2)`,
          ['p6_service_sub', 'p6service@example.com'],
        );
        tenantP6 = r.rows[0]!.tenant_id;
      } finally {
        seedClient.release();
      }

      // Seed openprovider_accounts inside a proper RLS-scoped transaction.
      await runAsTenant(pool, tenantP6, async (client) => {
        await client.query(
          `INSERT INTO openprovider_accounts (tenant_id, username)
           VALUES ($1, 'op-p6')
           ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username`,
          [tenantP6],
        );
      });

      // Encrypt and store the Openprovider password for the tenant.
      const kmsLocal = createFakeKms();
      await runAsTenant(pool, tenantP6, async (client) => {
        const store = createSecretsStore({
          kms: kmsLocal,
          kmsKeyArn: 'fake-key',
          repo: createDbSecretsRepo(client),
        });
        await store.put(tenantP6, 'openprovider.password', Buffer.from('pw-p6'));
      });

      // Issue an API key under the tenant context.
      await runAsTenant(pool, tenantP6, async (client) => {
        const issued = await issueApiKey(client, {
          tenantId: tenantP6,
          name: 'p6-test-key',
          scopes: ['mcp:read', 'mcp:write'],
        });
        issuedKey = issued.key;
        issuedKeyId = issued.id;
      });

      // Build a dispatchFactory wired with check_domain + apiKeyResolver.
      const openproviderClient = createOpenproviderClient();
      const apiKeyResolver = createApiKeyResolver(pool);

      async function p6DispatchFactory(principal: Principal) {
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

      p6App = await createMcpServer({
        devToken: 'never-used-p6',
        devPrincipal: {
          kind: 'user',
          tenantId: '00000000-0000-0000-0000-000000000000',
          userId: '00000000-0000-0000-0000-000000000000',
          subject: 'dev',
          scopes: [],
          role: 'viewer',
        },
        apiKeyResolver,
        dispatchFactory: p6DispatchFactory,
      });
      await p6App.listen({ host: '127.0.0.1', port: 0 });
      const addr = p6App.server.address() as AddressInfo;
      p6BaseUrl = `http://127.0.0.1:${addr.port}`;
    }, 120_000);

    afterAll(async () => {
      if (p6App) await p6App.close();
      nock.cleanAll();
    });

    async function p6InitSession(bearer: string): Promise<{ sid: string; status: number }> {
      const r = await fetch(`${p6BaseUrl}/mcp`, {
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
            clientInfo: { name: 'e2e-p6', version: '0' },
          },
        }),
      });
      const sid = r.headers.get('mcp-session-id') ?? '';
      return { sid, status: r.status };
    }

    async function p6CallCheckDomain(sid: string, bearer: string): Promise<unknown> {
      const r = await fetch(`${p6BaseUrl}/mcp`, {
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
            arguments: { domains: [{ name: 'p6test', extension: 'com' }], with_price: false },
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

    it('scenario P6-a: valid API key authenticates /mcp and check_domain succeeds', async () => {
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .reply(200, { data: { token: 'jwt-p6a', reseller_id: 1 } });
      nock('https://api.openprovider.eu')
        .post('/v1beta/domains/check')
        .reply(200, { data: { results: [{ domain: 'p6test.com', status: 'free' }] } });

      const { sid, status } = await p6InitSession(issuedKey);
      expect(status).toBe(200);
      expect(sid).toBeTruthy();

      const body = (await p6CallCheckDomain(sid, issuedKey)) as {
        result?: { content: { text: string }[] };
        error?: { message: string };
      };
      const innerText = body.result?.content[0]?.text;
      expect(innerText, 'check_domain should succeed, got: ' + JSON.stringify(body)).toBeDefined();
      const parsed = JSON.parse(innerText ?? '{}') as { results: { domain: string }[] };
      expect(parsed.results[0]?.domain).toBe('p6test.com');
    }, 60_000);

    it('scenario P6-b: revoked API key → 401', async () => {
      // Revoke the key.
      await runAsTenant(pool, tenantP6, async (c) => {
        await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [issuedKeyId]);
      });

      const { status } = await p6InitSession(issuedKey);
      expect(status).toBe(401);
    }, 30_000);
  });
});

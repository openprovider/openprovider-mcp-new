import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import nock from 'nock';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { startLocalstackKms, type KmsFixture } from '../_helpers/localstack-kms.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createFakeJwks, type FakeJwks } from '../_helpers/fake-jwks.js';

import { createMcpServer } from '../../../src/mcp/transport.js';
import { createWorkOsVerifier } from '../../../src/auth/oauth/workos.js';
import { createTenantResolver } from '../../../src/auth/tenant-resolver.js';
import { createAwsKms } from '../../../src/secrets/aws-kms.js';
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

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b1';

// oauth_subject values seeded into users rows for scenarios 1-2.
const SUB_TENANT_A = 'sub_tenant_a';
const SUB_TENANT_B = 'sub_tenant_b';

describe('phase 2 end-to-end', () => {
  let pgFixture: PgFixture;
  let kmsFixture: KmsFixture;
  let pool: pg.Pool;
  let jwks: FakeJwks;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    // Boot infra in parallel.
    [pgFixture, kmsFixture, jwks] = await Promise.all([
      startPostgres(),
      startLocalstackKms(),
      createFakeJwks(),
    ]);
    jwks.install();

    const m = await migratedDb(pgFixture.url);
    pool = m.pool;

    // Seed two tenants, each with an Openprovider account row and encrypted password.
    const kms = createAwsKms({ region: 'eu-central-1', endpoint: kmsFixture.endpoint });

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
          kmsKeyArn: kmsFixture.keyArn,
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
            kmsKeyArn: kmsFixture.keyArn,
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
    if (kmsFixture) await kmsFixture.stop();
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
    const kms = createAwsKms({ region: 'eu-central-1', endpoint: kmsFixture.endpoint });

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
        kmsKeyArn: kmsFixture.keyArn,
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
});

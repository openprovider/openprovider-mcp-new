import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { createAwsKms } from '../../../src/secrets/aws-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import { createDispatcher } from '../../../src/mcp/dispatch.js';
import { createPgAuditSink } from '../../../src/audit/pg-sink.js';
import { createCheckDomainTool } from '../../../src/tools/check-domain.js';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';
import { createOpenproviderTokenManager } from '../../../src/openprovider/token-manager.js';
import { createPgTokenCache } from '../../../src/openprovider/token-cache-pg.js';
import type { Principal } from '../../../src/auth/principal.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b1';

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

    // Insert tenants and openprovider_accounts as superuser (bypasses RLS).
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
          if (!username) throw new Error(`no openprovider account for ${tid}`);
          const store = createSecretsStore({
            kms,
            kmsKeyArn: kmsFixture.keyArn,
            repo: createDbSecretsRepo(client),
          });
          const passwordBuf = await store.get(tid, 'openprovider.password');
          if (!passwordBuf) throw new Error(`no openprovider password for ${tid}`);
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

    const bearer = await jwks.mintToken({
      sub: 'user_a',
      scope: 'mcp:read',
      'act.tnt': TENANT_A,
    });

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

    const bearer = await jwks.mintToken({
      sub: 'user_b',
      scope: 'mcp:read',
      'act.tnt': TENANT_B,
    });

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
});

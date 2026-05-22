import 'dotenv/config';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/transport.js';
import { startOtel } from './observability/otel.js';
import { createLogger } from './observability/logger.js';
import { createDb } from './db/client.js';
import { createAwsKms } from './secrets/aws-kms.js';
import { createWorkOsVerifier } from './auth/oauth/workos.js';
import type { Principal } from './auth/principal.js';
import { createDispatcher } from './mcp/dispatch.js';
import { createPgAuditSink } from './audit/pg-sink.js';
import { createCheckDomainTool } from './tools/check-domain.js';
import { createOpenproviderClient } from './openprovider/client.js';
import { createOpenproviderTokenManager } from './openprovider/token-manager.js';
import { createPgTokenCache } from './openprovider/token-cache-pg.js';
import { createSecretsStore } from './secrets/store.js';
import { createDbSecretsRepo } from './secrets/db-repo.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel });
  const otel = startOtel({
    serviceName: 'openprovider-mcp',
    ...(cfg.otlpEndpoint ? { exporterUrl: cfg.otlpEndpoint } : {}),
  });

  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const kms = createAwsKms({
    region: cfg.awsRegion,
    ...(cfg.awsEndpoint ? { endpoint: cfg.awsEndpoint } : {}),
  });

  const verifier = createWorkOsVerifier({
    clientId: cfg.workosClientId,
    issuer: cfg.workosIssuer,
    jwksUri: cfg.workosJwksUri,
  });

  const devPrincipal: Principal = {
    kind: 'user',
    tenantId: '00000000-0000-0000-0000-000000000001',
    userId: '00000000-0000-0000-0000-000000000002',
    subject: 'dev',
    scopes: ['mcp:read'],
    role: 'owner',
  };

  // Shared Openprovider HTTP client (stateless — safe to share across requests).
  const openproviderClient = createOpenproviderClient();

  /**
   * Per-request factory. Acquires one pg pool client, sets tenant role + GUC,
   * and constructs the dispatcher with all deps bound to that connection.
   * The connection is committed/released in cleanup().
   */
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

      // Resolve per-tenant Openprovider credentials lazily from the secrets store.
      const fetchCredentials = async (
        tenantId: string,
      ): Promise<{ username: string; password: string }> => {
        const u = await client.query<{ username: string }>(
          'SELECT username FROM openprovider_accounts WHERE tenant_id = $1',
          [tenantId],
        );
        const username = u.rows[0]?.username;
        if (!username) throw new Error(`no openprovider account for tenant ${tenantId}`);
        const store = createSecretsStore({
          kms,
          kmsKeyArn: cfg.kmsKeyArn,
          repo: createDbSecretsRepo(client),
        });
        const passwordBuf = await store.get(tenantId, 'openprovider.password');
        if (!passwordBuf) throw new Error(`no openprovider password for tenant ${tenantId}`);
        return { username, password: passwordBuf.toString('utf8') };
      };

      const tokenManager = createOpenproviderTokenManager({
        fetchCredentials,
        cache: createPgTokenCache({
          client,
          getDek: async (tenantId: string) => {
            // Read the wrapped DEK directly from tenant_keys and decrypt via KMS.
            const r = await client.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
              'SELECT wrapped_dek, kms_key_arn FROM tenant_keys WHERE tenant_id = $1',
              [tenantId],
            );
            if (!r.rows[0]) throw new Error(`no tenant_keys row for ${tenantId}`);
            return kms.decrypt(r.rows[0].kms_key_arn, r.rows[0].wrapped_dek);
          },
        }),
      });

      const tools = [createCheckDomainTool({ client: openproviderClient, tokenManager })];

      const dispatch = createDispatcher({
        tools,
        audit: createPgAuditSink(client),
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

  const app = await createMcpServer({
    devToken: cfg.devBearerToken,
    devPrincipal,
    verifier,
    oauth: {
      authorizationServer: cfg.workosAuthkitDomain,
      resource: `http://localhost:${cfg.port}`,
      scopesSupported: ['mcp:read', 'mcp:write'],
    },
    dispatchFactory,
    readinessChecks: [
      {
        name: 'db',
        check: async () => {
          const c = await pool.connect();
          try {
            await c.query('SELECT 1');
            return true;
          } finally {
            c.release();
          }
        },
      },
      {
        name: 'kms',
        check: async () => {
          await kms.generateDataKey(cfg.kmsKeyArn);
          return true;
        },
      },
    ],
  });

  const shutdown = async (): Promise<void> => {
    logger.info({ event: 'shutdown' }, 'shutting down');
    await app.close();
    await pool.end();
    await otel.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  await app.listen({ host: '0.0.0.0', port: cfg.port });
  logger.info({ event: 'startup', port: cfg.port }, 'mcp server listening');
}

main().catch((err: unknown) => {
  // Last-resort logger; full one may not have started.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

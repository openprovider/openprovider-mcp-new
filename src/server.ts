import 'dotenv/config';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/transport.js';
import { startOtel } from './observability/otel.js';
import { createLogger } from './observability/logger.js';
import { createDb } from './db/client.js';
import { createAwsKms } from './secrets/aws-kms.js';
import { createWorkOsVerifier } from './auth/oauth/workos.js';
import type { Principal } from './auth/principal.js';

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

  const app = await createMcpServer({
    devToken: cfg.devBearerToken,
    devPrincipal,
    verifier,
    oauth: {
      authorizationServer: cfg.workosAuthkitDomain,
      resource: `http://localhost:${cfg.port}`,
      scopesSupported: ['mcp:read', 'mcp:write'],
    },
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

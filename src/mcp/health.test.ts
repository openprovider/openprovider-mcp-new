import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpServer } from './transport.js';
import type { Principal } from '../auth/principal.js';

const devPrincipal: Principal = {
  kind: 'user',
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  userId: '00000000-0000-0000-0000-0000000000bb',
  subject: 'dev',
  scopes: ['mcp:read'],
  role: 'owner',
};

describe('health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createMcpServer({
      devToken: 'dev',
      devPrincipal,
      readinessChecks: [
        { name: 'db', check: () => Promise.resolve(true) },
        { name: 'kms', check: () => Promise.resolve(false) },
      ],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/healthz returns 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
  });

  it('/readyz returns 503 with structured failures when any check fails', async () => {
    const r = await app.inject({ method: 'GET', url: '/readyz' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ready: false, checks: { db: 'ok', kms: 'fail' } });
  });
});

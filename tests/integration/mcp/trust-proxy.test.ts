import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpServer } from '../../../src/mcp/transport.js';

const MINIMAL_CONFIG = {
  devToken: 'trust-proxy-test-token',
  devPrincipal: {
    kind: 'user' as const,
    tenantId: '00000000-0000-0000-0000-000000000000',
    userId: '00000000-0000-0000-0000-000000000000',
    subject: 'dev',
    scopes: [] as string[],
    role: 'viewer' as const,
  },
};

/**
 * Fastify's initialConfig does not expose trustProxy in this version.
 * Instead we verify behaviorally: inject a request carrying
 * X-Forwarded-For and assert whether req.ip picks up the spoofed address.
 *
 * When trustProxy=true  → req.ip === '203.0.113.9'  (XFF honored)
 * When trustProxy=false → req.ip !== '203.0.113.9'  (XFF ignored; real socket IP used)
 */
async function resolvedIpForXff(app: FastifyInstance, xff: string): Promise<string> {
  // Register a one-shot route that echoes req.ip. Must be done before ready().
  app.get('/__test_ip', (req) => Promise.resolve({ ip: req.ip }));
  await app.ready();
  const res = await app.inject({
    method: 'GET',
    url: '/__test_ip',
    headers: { 'x-forwarded-for': xff },
  });
  return (JSON.parse(res.body) as { ip: string }).ip;
}

describe('createMcpServer trustProxy wiring', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('honors X-Forwarded-For when trustProxy=true', async () => {
    app = await createMcpServer({ ...MINIMAL_CONFIG, trustProxy: true });
    const ip = await resolvedIpForXff(app, '203.0.113.9');
    expect(ip).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For when trustProxy is omitted (defaults false)', async () => {
    app = await createMcpServer({ ...MINIMAL_CONFIG });
    const ip = await resolvedIpForXff(app, '203.0.113.9');
    expect(ip).not.toBe('203.0.113.9');
  });
});

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

describe('createMcpServer trustProxy wiring', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('sets trustProxy=true when config.trustProxy is true', async () => {
    app = await createMcpServer({ ...MINIMAL_CONFIG, trustProxy: true });
    expect(app.initialConfig.trustProxy).toBe(true);
  });

  it('defaults trustProxy to false when config.trustProxy is omitted', async () => {
    app = await createMcpServer({ ...MINIMAL_CONFIG });
    expect(app.initialConfig.trustProxy).toBe(false);
  });
});

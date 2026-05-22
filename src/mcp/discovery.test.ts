import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpServer } from './transport.js';
import type { Principal } from '../auth/principal.js';

const devPrincipal: Principal = {
  kind: 'user',
  tenantId: 't',
  userId: 'u',
  subject: 'dev',
  scopes: [],
  role: 'owner',
};

describe('well-known discovery', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createMcpServer({
      devToken: 'dev',
      devPrincipal,
      oauth: {
        authorizationServer: 'https://your-org.authkit.app',
        resource: 'https://mcp.example.com',
        scopesSupported: ['mcp:read', 'mcp:write'],
      },
    });
    await app.ready();
  });
  afterAll(async () => app.close());

  it('serves /.well-known/oauth-protected-resource', async () => {
    const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(r.statusCode).toBe(200);
    const body = r.json<Record<string, unknown>>();
    expect(body.resource).toBe('https://mcp.example.com');
    expect(body.authorization_servers).toEqual(['https://your-org.authkit.app']);
    expect(body.scopes_supported).toEqual(['mcp:read', 'mcp:write']);
    expect(body.bearer_methods_supported).toContain('header');
  });

  it('serves 404 when no oauth config (open mode)', async () => {
    const open = await createMcpServer({ devToken: 'dev', devPrincipal });
    await open.ready();
    const r = await open.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(r.statusCode).toBe(404);
    await open.close();
  });
});

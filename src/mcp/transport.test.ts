import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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

describe('mcp transport', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createMcpServer({ devToken: 'dev', devPrincipal });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated MCP requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists the placeholder tool when authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
    });
    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body: { result: { tools: { name: string }[] } } = res.json();
    expect(body.result.tools.map((t) => t.name)).toContain('phase1.echo');
  });

  it('invokes the placeholder tool', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'phase1.echo', arguments: { message: 'hi' } },
      },
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
    });
    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body: { result: { content: { type: string; text: string }[] } } = res.json();
    expect(body.result.content[0]?.text).toContain('hi');
  });

  it('returns -32601 for unknown methods', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 3, method: 'unknown/method' },
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
    });
    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body: { error: { code: number } } = res.json();
    expect(body.error.code).toBe(-32601);
  });
});

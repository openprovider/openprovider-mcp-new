import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
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

/** Parse a response that may be plain JSON or SSE-framed (data: ...) */
async function parseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.includes('data:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (dataLine) return JSON.parse(dataLine.slice(5).trim()) as unknown;
  }
  return JSON.parse(text) as unknown;
}

/** Perform the MCP initialize handshake and return the assigned session ID */
async function initializeSession(baseUrl: string, authHeader: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: authHeader,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    }),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`initialize failed with ${res.status}: ${body}`);
  }
  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('No mcp-session-id in initialize response');
  return sessionId;
}

describe('mcp transport', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createMcpServer({ devToken: 'dev', devPrincipal });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated MCP requests with 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.1' },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('lists the placeholder tool when authenticated', async () => {
    const sessionId = await initializeSession(baseUrl, 'Bearer dev');

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer dev',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body = (await parseResponse(res)) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain('phase1.echo');
  });

  it('invokes the placeholder tool', async () => {
    const sessionId = await initializeSession(baseUrl, 'Bearer dev');

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer dev',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'phase1.echo', arguments: { message: 'hi' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await parseResponse(res);
    expect(JSON.stringify(body)).toContain('hi');
  });

  it('returns 400 for non-initialize requests without session ID', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer dev',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });
});

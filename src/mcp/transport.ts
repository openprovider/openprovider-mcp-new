import Fastify, { type FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpSdkServer, type ToolEntry } from './sdk-transport.js';
import { createIdentityResolver } from '../auth/identity.js';
import type { Principal } from '../auth/principal.js';
import type { AccessTokenVerifier } from '../auth/oauth/workos.js';
import { withRequestContext } from '../observability/request-context.js';
import { randomUUID } from 'node:crypto';

export interface McpServerConfig {
  devToken: string;
  devPrincipal: Principal;
  readinessChecks?: { name: string; check: () => Promise<boolean> }[];
  oauth?: {
    authorizationServer: string;
    resource: string;
    scopesSupported: string[];
  };
  tools?: ToolEntry[];
  verifier?: AccessTokenVerifier;
}

export async function createMcpServer(config: McpServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const resolve = createIdentityResolver({
    devToken: config.devToken,
    devPrincipal: config.devPrincipal,
    ...(config.verifier !== undefined ? { verifier: config.verifier } : {}),
  });

  app.get('/healthz', () => Promise.resolve({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    const checks = config.readinessChecks ?? [];
    const results: Record<string, 'ok' | 'fail'> = {};
    for (const c of checks) {
      try {
        results[c.name] = (await c.check()) ? 'ok' : 'fail';
      } catch {
        results[c.name] = 'fail';
      }
    }
    const ready = Object.values(results).every((v) => v === 'ok');
    void reply.code(ready ? 200 : 503);
    return { ready, checks: results };
  });

  if (config.oauth) {
    const oauth = config.oauth;
    app.get('/.well-known/oauth-protected-resource', () =>
      Promise.resolve({
        resource: oauth.resource,
        authorization_servers: [oauth.authorizationServer],
        scopes_supported: oauth.scopesSupported,
        bearer_methods_supported: ['header'],
      }),
    );
  }

  // Per-session SDK transport tracking (process-local; Phase 6+ may move to Redis)
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  app.post('/mcp', async (req, reply) => {
    const principal = await resolve(req.headers.authorization);
    if (!principal) {
      void reply.code(401).send({ error: 'unauthenticated' });
      return;
    }

    const existingSessionId = req.headers['mcp-session-id'] as string | undefined;

    let entry: { server: Server; transport: StreamableHTTPServerTransport } | undefined;

    if (existingSessionId) {
      // Subsequent request — look up the existing session
      entry = sessions.get(existingSessionId);
      if (!entry) {
        void reply.code(404).send({ error: 'session not found' });
        return;
      }
    } else {
      // No session ID: must be an initialize request
      const body = req.body as { method?: string } | Array<{ method?: string }> | undefined;
      const isInit = Array.isArray(body)
        ? body.some((m) => isInitializeRequest(m))
        : isInitializeRequest(body as Record<string, unknown>);

      if (!isInit) {
        void reply
          .code(400)
          .send({ error: 'Mcp-Session-Id header required for non-initialize requests' });
        return;
      }

      // Create a new session — the transport generates its own ID via sessionIdGenerator
      const newSessionId = randomUUID();
      const server = createMcpSdkServer(config.tools);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { server, transport });
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      await server.connect(transport as any);
      entry = { server, transport };
    }

    // Hijack the reply so Fastify doesn't try to serialize after handleRequest
    // writes directly to reply.raw (Node ServerResponse).
    void reply.hijack();
    const resolvedEntry = entry;
    await withRequestContext(
      {
        tenantId: principal.tenantId,
        principalSubject: principal.subject,
        principalKind: principal.kind,
      },
      () => resolvedEntry.transport.handleRequest(req.raw, reply.raw, req.body),
    );
  });

  app.get('/mcp', async (req, reply) => {
    const principal = await resolve(req.headers.authorization);
    if (!principal) {
      void reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      void reply.code(400).send({ error: 'mcp-session-id required for SSE' });
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      void reply.code(404).send({ error: 'session not found' });
      return;
    }
    void reply.hijack();
    await entry.transport.handleRequest(req.raw, reply.raw);
  });

  return app;
}

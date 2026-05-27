import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpSdkServer, type ToolEntry } from './sdk-transport.js';
import { createIdentityResolver } from '../auth/identity.js';
import type { Principal } from '../auth/principal.js';
import type { ApiKeyResolver } from '../auth/api-key.js';
import { withRequestContext } from '../observability/request-context.js';
import { randomUUID } from 'node:crypto';

// Module augmentation so req.principal is typed throughout the request lifecycle.
declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface DispatchFactory {
  (principal: Principal): Promise<{
    dispatch: (input: { name: string; args: unknown; principal: Principal }) => Promise<unknown>;
    cleanup: () => Promise<void>;
  }>;
}

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
  apiKeyResolver?: ApiKeyResolver;
  /**
   * Factory invoked per `tools/call` request. Receives the principal and returns a fully-wired
   * dispatch function plus a cleanup callback. Phase 2 uses this to acquire a pg connection,
   * set tenant role + GUC, and bind the audit sink + token manager + tool deps to that connection.
   * When present, `tools/call` requests are intercepted before the SDK transport and handled
   * directly; all other MCP methods (initialize, tools/list, SSE) continue through the SDK.
   */
  dispatchFactory?: DispatchFactory;
}

export async function createMcpServer(config: McpServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const resolve = createIdentityResolver({
    devToken: config.devToken,
    devPrincipal: config.devPrincipal,
    ...(config.apiKeyResolver !== undefined ? { apiKeyResolver: config.apiKeyResolver } : {}),
  });

  // Auth hook must run BEFORE the rate-limit plugin registers its own onRequest hook,
  // so that req.principal is set by the time the limiter's keyGenerator runs.
  app.addHook('onRequest', async (req, reply) => {
    // Only guard /mcp routes; health + discovery endpoints are public.
    if (!req.url.startsWith('/mcp')) return;
    let principal: Principal | null = null;
    try {
      principal = await resolve(req.headers.authorization);
    } catch {
      // Unexpected resolver error — treat as 401.
      principal = null;
    }
    if (!principal) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return reply;
    }
    req.principal = principal;
  });

  await app.register(rateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.principal?.subject ?? `anon:${req.ip}`,
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

  app.post(
    '/mcp',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      // req.principal is guaranteed by the onRequest hook (which already sent 401 if missing).
      const principal = req.principal!;

      // ---------------------------------------------------------------------------
      // Fast-path: intercept tools/call before the SDK transport when a
      // dispatchFactory is configured. This keeps the per-request pg connection
      // scope entirely outside the SDK transport while the SDK still handles
      // initialize / tools/list / SSE plumbing.
      // ---------------------------------------------------------------------------
      if (config.dispatchFactory) {
        const body = req.body as
          | { method?: string; id?: unknown; params?: { name?: string; arguments?: unknown } }
          | undefined;
        if (body && body.method === 'tools/call') {
          const toolName = body.params?.name ?? '';
          const toolArgs = body.params?.arguments ?? {};
          const { dispatch, cleanup } = await config.dispatchFactory(principal);
          try {
            const result = await withRequestContext(
              {
                tenantId: principal.tenantId,
                principalSubject: principal.subject,
                principalKind: principal.kind,
              },
              () => dispatch({ name: toolName, args: toolArgs, principal }),
            );
            void reply.send({
              jsonrpc: '2.0',
              id: body.id ?? null,
              result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = (err as { code?: string }).code ?? 'internal_error';
            void reply.send({
              jsonrpc: '2.0',
              id: body.id ?? null,
              error: { code: -32603, message: msg, data: { code } },
            });
          } finally {
            await cleanup();
          }
          return;
        }
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
    },
  );

  app.get(
    '/mcp',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      // req.principal is guaranteed by the onRequest hook (which already sent 401 if missing).
      // The GET /mcp handler is the SSE stream endpoint; the principal is not used directly here
      // but is verified to exist by the hook before this handler runs.
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
    },
  );

  return app;
}

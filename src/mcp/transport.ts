import Fastify, { type FastifyInstance } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { placeholderTool } from './placeholder-tool.js';
import { createIdentityResolver } from '../auth/identity.js';
import type { Principal } from '../auth/principal.js';
import { withRequestContext } from '../observability/request-context.js';

export interface McpServerConfig {
  devToken: string;
  devPrincipal: Principal;
  readinessChecks?: { name: string; check: () => Promise<boolean> }[];
}

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
};

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: number | string | null; result: unknown }
  | { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string } };

const TOOLS = [placeholderTool];

export async function createMcpServer(config: McpServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const resolve = createIdentityResolver(config);

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

  app.post('/mcp', async (req, reply): Promise<JsonRpcResponse> => {
    const principal = await resolve(req.headers.authorization);
    if (!principal) {
      void reply.code(401);
      return { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unauthenticated' } };
    }
    const rpc = req.body as JsonRpcRequest;
    return withRequestContext(
      {
        tenantId: principal.tenantId,
        principalSubject: principal.subject,
        principalKind: principal.kind,
      },
      async (): Promise<JsonRpcResponse> => {
        try {
          if (rpc.method === 'tools/list') {
            const result = {
              tools: TOOLS.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: zodToJsonSchema(t.inputSchema) as Record<string, unknown>,
              })),
            };
            return { jsonrpc: '2.0', id: rpc.id, result };
          }
          if (rpc.method === 'tools/call') {
            const params = rpc.params as { name: string; arguments?: unknown } | undefined;
            const tool = TOOLS.find((t) => t.name === params?.name);
            if (!tool) {
              return {
                jsonrpc: '2.0',
                id: rpc.id,
                error: { code: -32602, message: `Tool not found: ${params?.name ?? '<missing>'}` },
              };
            }
            const parsed = tool.inputSchema.parse(params?.arguments ?? {});
            const result = await tool.handler(parsed);
            return {
              jsonrpc: '2.0',
              id: rpc.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
            };
          }
          return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found' } };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
          };
        }
      },
    );
  });

  return app;
}

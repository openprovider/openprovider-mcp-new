import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- ZodTypeAny used in cast
import { type ZodTypeDef, type ZodType, z } from 'zod';

// Inlined placeholder tool to avoid circular import issues
const _placeholderInputSchema = z.object({ message: z.string().min(1).max(256) });

const _inlinedPlaceholder: ToolEntry = {
  name: 'phase1.echo',
  description: 'Phase 1 placeholder. Echoes a message; proves transport + auth + audit wiring.',
  inputSchema: _placeholderInputSchema,
  handler: (raw: unknown): Promise<unknown> => {
    const input = _placeholderInputSchema.parse(raw);
    return Promise.resolve({ echoed: input.message });
  },
};

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: ZodType<unknown, ZodTypeDef, unknown>;
  handler: (input: unknown) => Promise<unknown>;
}

const DEFAULT_TOOLS: ToolEntry[] = [_inlinedPlaceholder];

export function createMcpSdkServer(tools: ToolEntry[] = DEFAULT_TOOLS): Server {
  const server = new Server(
    { name: 'openprovider-mcp', version: '0.2.0-phase2' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        inputSchema: zodToJsonSchema(t.inputSchema as any) as Record<string, unknown>,
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Tool not found: ${req.params.name}`);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parsed: unknown = tool.inputSchema.parse(req.params.arguments ?? {});
    const result = await tool.handler(parsed);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

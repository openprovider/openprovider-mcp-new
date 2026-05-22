import { z, type ZodTypeAny } from 'zod';
import type { Principal } from '../auth/principal.js';
import { redactSensitive } from '../observability/redact.js';

export interface DispatcherTool {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  handler: (args: unknown, principal: Principal) => Promise<unknown>;
}

export interface AuditRow {
  tenantId: string;
  actorKind: 'user' | 'service' | 'system';
  actorSubject: string;
  eventType: 'tool.call' | 'tool.result' | 'tool.error';
  toolName: string;
  requestArgs?: unknown;
  result?: unknown;
  errorCode?: string;
}

export interface DispatcherConfig {
  tools: DispatcherTool[];
  audit: (row: AuditRow) => Promise<void>;
}

export class DispatchError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface DispatchInput {
  name: string;
  args: unknown;
  principal: Principal;
}

export function createDispatcher(config: DispatcherConfig) {
  return async (input: DispatchInput): Promise<unknown> => {
    const tool = config.tools.find((t) => t.name === input.name);
    if (!tool) {
      throw new DispatchError('tool_not_found', `tool not found: ${input.name}`);
    }
    let parsed: unknown;
    try {
      parsed = tool.inputSchema.parse(input.args);
    } catch (err) {
      await config.audit({
        tenantId: input.principal.tenantId,
        actorKind: input.principal.kind,
        actorSubject: input.principal.subject,
        eventType: 'tool.error',
        toolName: tool.name,
        requestArgs: redactSensitive(input.args),
        errorCode: 'validation_failed',
      });
      throw new DispatchError(
        'validation_failed',
        err instanceof z.ZodError ? err.message : String(err),
      );
    }
    await config.audit({
      tenantId: input.principal.tenantId,
      actorKind: input.principal.kind,
      actorSubject: input.principal.subject,
      eventType: 'tool.call',
      toolName: tool.name,
      requestArgs: redactSensitive(parsed),
    });
    try {
      const result = await tool.handler(parsed, input.principal);
      await config.audit({
        tenantId: input.principal.tenantId,
        actorKind: input.principal.kind,
        actorSubject: input.principal.subject,
        eventType: 'tool.result',
        toolName: tool.name,
        result: redactSensitive(result),
      });
      return result;
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'upstream_error';
      await config.audit({
        tenantId: input.principal.tenantId,
        actorKind: input.principal.kind,
        actorSubject: input.principal.subject,
        eventType: 'tool.error',
        toolName: tool.name,
        errorCode: code,
      });
      throw err;
    }
  };
}

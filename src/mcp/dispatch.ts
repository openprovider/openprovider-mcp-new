import { z, type ZodTypeAny } from 'zod';
import type { Principal } from '../auth/principal.js';
import type { Role } from '../policies/schema.js';
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

export interface ProposeResult {
  confirmationId: string;
  confirmationToken: string;
  summary: string;
  estimatedCostEur: number;
  requiredApproverRoles: Role[];
  expiresAt: string;
}

export interface ConfirmDeps {
  resolveMode: (toolName: string, principal: Principal) => Promise<'allow' | 'confirm' | 'deny'>;
  propose: (input: {
    toolName: string;
    args: unknown;
    principal: Principal;
  }) => Promise<{ kind: 'denied'; reason: string } | { kind: 'proposed'; result: ProposeResult }>;
  consume: (input: {
    token: string;
    toolName: string;
    args: unknown;
    principal: Principal;
  }) => Promise<{ kind: 'error'; code: string } | { kind: 'ok'; confirmationId: string }>;
  settle?: (confirmationId: string, outcome: 'committed' | 'released') => Promise<void>;
}

export interface DispatcherConfig {
  tools: DispatcherTool[];
  audit: (row: AuditRow) => Promise<void>;
  confirm?: ConfirmDeps;
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
  confirm?: { token: string };
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

    // Confirm-mode branch
    if (config.confirm) {
      const mode = await config.confirm.resolveMode(tool.name, input.principal);

      if (mode === 'deny') {
        await config.audit({
          tenantId: input.principal.tenantId,
          actorKind: input.principal.kind,
          actorSubject: input.principal.subject,
          eventType: 'tool.error',
          toolName: tool.name,
          requestArgs: redactSensitive(parsed),
          errorCode: 'policy_denied',
        });
        throw new DispatchError('policy_denied', 'tool_not_permitted');
      }

      if (mode === 'confirm') {
        if (!input.confirm) {
          // No token — propose
          const proposeOut = await config.confirm.propose({
            toolName: tool.name,
            args: parsed,
            principal: input.principal,
          });

          if (proposeOut.kind === 'denied') {
            await config.audit({
              tenantId: input.principal.tenantId,
              actorKind: input.principal.kind,
              actorSubject: input.principal.subject,
              eventType: 'tool.error',
              toolName: tool.name,
              requestArgs: redactSensitive(parsed),
              errorCode: 'policy_denied',
            });
            throw new DispatchError('policy_denied', proposeOut.reason);
          }

          // Return the proposed result directly (client sees confirmation_required shape)
          await config.audit({
            tenantId: input.principal.tenantId,
            actorKind: input.principal.kind,
            actorSubject: input.principal.subject,
            eventType: 'tool.call',
            toolName: tool.name,
            requestArgs: redactSensitive(parsed),
            result: proposeOut.result,
          });
          return proposeOut.result;
        }

        // Token present — consume
        const consumeOut = await config.confirm.consume({
          token: input.confirm.token,
          toolName: tool.name,
          args: parsed,
          principal: input.principal,
        });

        if (consumeOut.kind === 'error') {
          await config.audit({
            tenantId: input.principal.tenantId,
            actorKind: input.principal.kind,
            actorSubject: input.principal.subject,
            eventType: 'tool.error',
            toolName: tool.name,
            requestArgs: redactSensitive(parsed),
            errorCode: consumeOut.code,
          });
          throw new DispatchError(consumeOut.code, consumeOut.code);
        }

        // consume ok — run the handler, then settle
        const { confirmationId } = consumeOut;
        try {
          const result = await tool.handler(parsed, input.principal);
          if (config.confirm.settle) {
            await config.confirm.settle(confirmationId, 'committed');
          }
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
          if (config.confirm.settle) {
            await config.confirm.settle(confirmationId, 'released');
          }
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
      }

      // mode === 'allow' falls through to existing behavior below
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

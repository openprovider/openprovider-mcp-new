import { z } from 'zod';
import type { Principal } from '../auth/principal.js';

export const ConfirmPendingArgs = z.object({
  confirmation_id: z.string().uuid(),
  args: z.unknown(),
});

export interface ConfirmPendingDeps {
  consume: (input: {
    confirmationId: string;
    args: unknown;
    principal: Principal;
  }) => Promise<{ kind: 'error'; code: string } | { kind: 'ok'; result: unknown }>;
}

export function createConfirmPendingTool(deps: ConfirmPendingDeps) {
  return {
    name: 'confirm_pending',
    description: 'Approve and execute a previously proposed confirmation by id.',
    inputSchema: ConfirmPendingArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ConfirmPendingArgs.parse(args);
      const out = await deps.consume({
        confirmationId: parsed.confirmation_id,
        args: parsed.args,
        principal,
      });
      if (out.kind === 'error') {
        throw Object.assign(new Error(out.code), { code: out.code });
      }
      return out.result;
    },
  };
}

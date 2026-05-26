/**
 * Reusable confirm-pending consume logic.
 *
 * Extracted from dispatchFactory in src/server.ts so both the MCP
 * confirm_pending tool and the dashboard confirmations approve route
 * can call the same validate → claim → execute → settle path without
 * duplication.
 *
 * Usage:
 *   const consumeFn = createConfirmPendingConsume({ tools, validateConfirmation, claim, unclaim, settle });
 *   // server.ts: createConfirmPendingTool({ consume: consumeFn })
 *   // dashboard approve handler: await consumeFn({ confirmationId, args, principal })
 */

import type { Principal } from '../auth/principal.js';
import type { LoadedConfirmation } from '../policies/repo.js';

export interface ConsumeToolDef {
  name: string;
  handler: (args: unknown, principal: Principal) => Promise<unknown>;
}

export interface ConfirmPendingConsumeDeps {
  /** All registered tools for this request — the confirm path looks up by stored tool_name. */
  tools: ConsumeToolDef[];
  /** Validate a token against the caller; returns the loaded confirmation or an error code. */
  validateConfirmation: (
    token: string,
    args: unknown,
    principal: Principal,
  ) => Promise<{ kind: 'error'; code: string } | { kind: 'ok'; conf: LoadedConfirmation }>;
  /** Atomically claim the confirmation (returns true if we won the race). */
  claimConfirmation: (client: unknown, confirmationId: string) => Promise<boolean>;
  /** Release a claim (on error path). */
  unclaimConfirmation: (client: unknown, confirmationId: string) => Promise<void>;
  /** Settle the confirmation as committed or released. */
  settleConfirmation: (
    client: unknown,
    confirmationId: string,
    outcome: 'committed' | 'released',
  ) => Promise<void>;
  /** The pg.PoolClient scoped to this request — forwarded to claim/unclaim/settle. */
  client: unknown;
}

export type ConfirmPendingConsumeFn = (input: {
  confirmationId: string;
  args: unknown;
  principal: Principal;
}) => Promise<{ kind: 'error'; code: string } | { kind: 'ok'; result: unknown }>;

/**
 * Returns the consume function used by both:
 *  - createConfirmPendingTool (MCP tool path, server.ts)
 *  - dashboard confirmations approve route
 */
export function createConfirmPendingConsume(
  deps: ConfirmPendingConsumeDeps,
): ConfirmPendingConsumeFn {
  return async (input) => {
    const validated = await deps.validateConfirmation(
      input.confirmationId,
      input.args,
      input.principal,
    );
    if (validated.kind === 'error') return validated;
    const { conf } = validated;

    // Look up the original tool by stored tool_name (not caller-supplied).
    const originalTool = deps.tools.find((t) => t.name === conf.toolName);
    if (!originalTool) {
      return { kind: 'error', code: 'tool_not_found' };
    }

    // Atomic claim — prevents concurrent double-execution of a billable/destructive op.
    const won = await deps.claimConfirmation(deps.client, conf.id);
    if (!won) return { kind: 'error', code: 'confirmation_not_found' };

    // Execute the original tool's handler and settle.
    try {
      const result = await originalTool.handler(input.args, input.principal);
      await deps.settleConfirmation(deps.client, conf.id, 'committed');
      return { kind: 'ok', result };
    } catch (err) {
      // Un-claim so a transient failure leaves the confirmation re-approvable.
      await deps.unclaimConfirmation(deps.client, conf.id);
      await deps.settleConfirmation(deps.client, conf.id, 'released');
      const code = (err as { code?: string }).code ?? 'upstream_error';
      return { kind: 'error', code };
    }
  };
}

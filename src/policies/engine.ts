import { toolMode, type PolicyDoc, type Role } from './schema.js';

export type Decision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'requires_confirmation' };

export interface EvaluateInput {
  toolName: string;
  args: unknown;
  role: Role;
  policy: PolicyDoc;
  liveSpendCents: number;
  estimatedCostCents: number;
  tldsInArgs: string[];
}

const READ_TOOLS = new Set(['list_pending_confirmations']);

const READ_PREFIXES = ['list_', 'get_', 'check_', 'suggest_'];

export function isReadTool(toolName: string): boolean {
  if (READ_TOOLS.has(toolName)) return true;
  return READ_PREFIXES.some((p) => toolName.startsWith(p));
}

/**
 * Role-aware tool mode: the policy's mode for the tool, narrowed to 'deny' when the
 * caller's role may not run it. A viewer may only run allow-mode READ tools; any other
 * tool a viewer attempts is denied. This is the single gate the allow-mode dispatch path
 * (resolveMode) and the confirm-mode propose path (evaluate) must agree on — without it,
 * allow-mode write tools (e.g. create_contact) would bypass the viewer restriction.
 */
export function resolveToolMode(
  policy: PolicyDoc,
  toolName: string,
  role: Role,
): 'allow' | 'confirm' | 'deny' {
  const mode = toolMode(policy, toolName);
  if (mode === 'deny') return 'deny';
  if ((role === 'viewer' || role === 'auditor') && !(mode === 'allow' && isReadTool(toolName)))
    return 'deny';
  return mode;
}

export function evaluate(input: EvaluateInput): Decision {
  const mode = toolMode(input.policy, input.toolName);
  if (mode === 'deny') return { decision: 'deny', reason: 'tool_not_permitted' };

  // Role gate: viewer may only run allow-mode read tools.
  if (
    (input.role === 'viewer' || input.role === 'auditor') &&
    !(mode === 'allow' && isReadTool(input.toolName))
  ) {
    return { decision: 'deny', reason: 'insufficient_role' };
  }

  // TLD gate (domain tools only).
  if (input.tldsInArgs.length > 0) {
    const deny = input.policy.tld_denylist.map((t) => t.replace(/^\./, ''));
    const allow = input.policy.tld_allowlist.map((t) => t.replace(/^\./, ''));
    for (const raw of input.tldsInArgs) {
      const tld = raw.replace(/^\./, '');
      if (deny.includes(tld)) return { decision: 'deny', reason: 'tld_denied' };
      if (allow.length > 0 && !allow.includes(tld))
        return { decision: 'deny', reason: 'tld_not_allowed' };
    }
  }

  // Spend gate (billable tools).
  if (input.estimatedCostCents > 0) {
    const limitCents = Math.round(input.policy.spend_caps.limit_eur * 100);
    if (input.liveSpendCents + input.estimatedCostCents > limitCents) {
      return { decision: 'deny', reason: 'spend_cap_exceeded' };
    }
  }

  return mode === 'confirm' ? { decision: 'requires_confirmation' } : { decision: 'allow' };
}

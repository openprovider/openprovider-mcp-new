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

const READ_TOOLS = new Set([
  'check_domain',
  'list_domains',
  'get_domain',
  'list_contacts',
  'get_contact',
  'list_pending_confirmations',
]);

export function evaluate(input: EvaluateInput): Decision {
  const mode = toolMode(input.policy, input.toolName);
  if (mode === 'deny') return { decision: 'deny', reason: 'tool_not_permitted' };

  // Role gate: viewer may only run allow-mode read tools.
  const isRead = READ_TOOLS.has(input.toolName);
  if (input.role === 'viewer' && !(mode === 'allow' && isRead)) {
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

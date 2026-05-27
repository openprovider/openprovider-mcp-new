import { z } from 'zod';

export const RoleEnum = z.enum(['owner', 'admin', 'operator', 'viewer']);
export type Role = z.infer<typeof RoleEnum>;

export const ModeEnum = z.enum(['allow', 'confirm']);
export type Mode = z.infer<typeof ModeEnum>;

const ToolRule = z.union([
  ModeEnum,
  z.object({ mode: ModeEnum, approvers: z.array(RoleEnum).optional() }),
]);

export const PolicyDoc = z.object({
  version: z.number().int().default(1),
  spend_caps: z.object({
    window: z.literal('month'),
    limit_eur: z.number().min(0),
  }),
  tld_allowlist: z.array(z.string()).default([]),
  tld_denylist: z.array(z.string()).default([]),
  tools: z.record(z.string(), ToolRule),
  ip_allowlist: z.array(z.string()).default([]),
});
export type PolicyDoc = z.infer<typeof PolicyDoc>;

export const DEFAULT_POLICY: PolicyDoc = {
  version: 1,
  spend_caps: { window: 'month', limit_eur: 0 },
  tld_allowlist: [],
  tld_denylist: [],
  tools: {
    'list_*': 'allow',
    'get_*': 'allow',
    'check_*': 'allow',
    'suggest_*': 'allow',
    check_domain: 'allow',
    register_domain: 'confirm',
    update_domain: 'confirm',
    delete_contact: 'confirm',
    update_contact: 'confirm',
    create_contact: 'allow',
    reset_domain_authcode: 'allow',
    approve_domain_transfer: 'allow',
    send_foa1_domain_transfer: 'allow',
    delete_domain: 'confirm',
    restart_domain_operation: 'confirm',
    renew_domain: 'confirm',
    transfer_domain: 'confirm',
    trade_domain: 'confirm',
    restore_domain: 'confirm',
  },
  ip_allowlist: [],
};

const DEFAULT_APPROVERS: Role[] = ['owner', 'admin'];

function ruleFor(policy: PolicyDoc, tool: string): z.infer<typeof ToolRule> | undefined {
  if (policy.tools[tool] !== undefined) return policy.tools[tool];
  // wildcard: longest matching prefix ending in '*'
  for (const [key, rule] of Object.entries(policy.tools)) {
    if (key.endsWith('*') && tool.startsWith(key.slice(0, -1))) return rule;
  }
  return undefined;
}

export function toolMode(policy: PolicyDoc, tool: string): Mode | 'deny' {
  const rule = ruleFor(policy, tool);
  if (rule === undefined) return 'deny';
  return typeof rule === 'string' ? rule : rule.mode;
}

export function requiredApproverRoles(policy: PolicyDoc, tool: string): Role[] {
  const rule = ruleFor(policy, tool);
  if (rule && typeof rule === 'object' && rule.approvers) return rule.approvers;
  return DEFAULT_APPROVERS;
}

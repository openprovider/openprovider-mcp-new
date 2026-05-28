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
    create_dns_zone: 'allow',
    update_dns_zone: 'allow',
    delete_dns_zone: 'confirm',
    create_nameserver: 'allow',
    update_nameserver: 'allow',
    delete_nameserver: 'confirm',
    create_ns_group: 'allow',
    update_ns_group: 'allow',
    delete_ns_group: 'confirm',
    create_dns_template: 'allow',
    delete_dns_template: 'confirm',
    create_domain_token: 'allow',
  },
  ip_allowlist: [],
};

const DEFAULT_APPROVERS: Role[] = ['owner', 'admin'];

export function ruleFor(policy: PolicyDoc, tool: string): z.infer<typeof ToolRule> | undefined {
  if (policy.tools[tool] !== undefined) return policy.tools[tool];
  // wildcard: pick the wildcard key whose prefix is the longest match for the tool name
  let bestKey: string | undefined;
  let bestLen = -1;
  for (const key of Object.keys(policy.tools)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (tool.startsWith(prefix) && prefix.length > bestLen) {
      bestKey = key;
      bestLen = prefix.length;
    }
  }
  return bestKey !== undefined ? policy.tools[bestKey] : undefined;
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

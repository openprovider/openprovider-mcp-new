import { describe, expect, it } from 'vitest';
import { PolicyDoc, DEFAULT_POLICY, requiredApproverRoles, toolMode, ruleFor } from './schema.js';

describe('policy schema', () => {
  it('parses the default policy', () => {
    expect(() => PolicyDoc.parse(DEFAULT_POLICY)).not.toThrow();
    expect(DEFAULT_POLICY.spend_caps.limit_eur).toBe(0);
  });

  it('accepts a tool object form with approvers', () => {
    const doc = PolicyDoc.parse({
      ...DEFAULT_POLICY,
      tools: {
        ...DEFAULT_POLICY.tools,
        register_domain: { mode: 'confirm', approvers: ['owner'] },
      },
    });
    expect(requiredApproverRoles(doc, 'register_domain')).toEqual(['owner']);
  });

  it('defaults approver roles to owner+admin for bare confirm strings', () => {
    expect(requiredApproverRoles(DEFAULT_POLICY, 'register_domain')).toEqual(['owner', 'admin']);
  });

  it('resolves tool mode with exact > wildcard > deny', () => {
    expect(toolMode(DEFAULT_POLICY, 'list_domains')).toBe('allow'); // list_* wildcard
    expect(toolMode(DEFAULT_POLICY, 'check_domain')).toBe('allow'); // exact
    expect(toolMode(DEFAULT_POLICY, 'register_domain')).toBe('confirm');
    expect(toolMode(DEFAULT_POLICY, 'unknown_tool')).toBe('deny');
  });

  it('rejects an unknown spend window', () => {
    expect(() =>
      PolicyDoc.parse({ ...DEFAULT_POLICY, spend_caps: { window: 'year', limit_eur: 1 } }),
    ).toThrow();
  });
});

describe('ruleFor longest-prefix wildcard matching', () => {
  const tools = { 'get_*': 'allow', 'get_secret_*': 'confirm', delete_domain: 'confirm' };
  const policy = { tools } as unknown as Parameters<typeof ruleFor>[0];

  it('exact match wins over any wildcard', () => {
    expect(ruleFor(policy, 'delete_domain')).toBe('confirm');
  });

  it('longest matching wildcard wins (get_secret_* beats get_*)', () => {
    expect(ruleFor(policy, 'get_secret_value')).toBe('confirm');
  });

  it('falls back to the broad wildcard when no longer prefix matches', () => {
    expect(ruleFor(policy, 'get_domain')).toBe('allow');
  });
});

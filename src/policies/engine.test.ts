import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluate } from './engine.js';
import { DEFAULT_POLICY, type PolicyDoc } from './schema.js';

const base = {
  args: {},
  role: 'owner' as const,
  liveSpendCents: 0,
  estimatedCostCents: 0,
  tldsInArgs: [] as string[],
};

describe('policies/engine', () => {
  it('allows an allow-mode read tool', () => {
    expect(evaluate({ ...base, toolName: 'check_domain', policy: DEFAULT_POLICY })).toEqual({
      decision: 'allow',
    });
  });

  it('denies an unknown tool', () => {
    expect(evaluate({ ...base, toolName: 'nope', policy: DEFAULT_POLICY }).decision).toBe('deny');
  });

  it('requires confirmation for a confirm-mode tool within cap', () => {
    const policy: PolicyDoc = {
      ...DEFAULT_POLICY,
      spend_caps: { window: 'month', limit_eur: 100 },
    };
    expect(
      evaluate({
        ...base,
        toolName: 'register_domain',
        estimatedCostCents: 1299,
        policy,
        tldsInArgs: ['com'],
      }).decision,
    ).toBe('requires_confirmation');
  });

  it('denies when spend would exceed the cap', () => {
    const policy: PolicyDoc = { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 10 } };
    const d = evaluate({
      ...base,
      toolName: 'register_domain',
      liveSpendCents: 900,
      estimatedCostCents: 200,
      policy,
      tldsInArgs: ['com'],
    });
    expect(d).toEqual({ decision: 'deny', reason: 'spend_cap_exceeded' });
  });

  it('denies a denylisted TLD', () => {
    const policy: PolicyDoc = {
      ...DEFAULT_POLICY,
      spend_caps: { window: 'month', limit_eur: 100 },
      tld_denylist: ['xxx'],
    };
    expect(
      evaluate({
        ...base,
        toolName: 'register_domain',
        estimatedCostCents: 100,
        policy,
        tldsInArgs: ['xxx'],
      }).decision,
    ).toBe('deny');
  });

  it('denies a TLD outside a non-empty allowlist', () => {
    const policy: PolicyDoc = {
      ...DEFAULT_POLICY,
      spend_caps: { window: 'month', limit_eur: 100 },
      tld_allowlist: ['com'],
    };
    expect(
      evaluate({
        ...base,
        toolName: 'register_domain',
        estimatedCostCents: 100,
        policy,
        tldsInArgs: ['net'],
      }).decision,
    ).toBe('deny');
  });

  it('viewer cannot invoke a confirm-mode write', () => {
    const policy: PolicyDoc = {
      ...DEFAULT_POLICY,
      spend_caps: { window: 'month', limit_eur: 100 },
    };
    expect(
      evaluate({
        ...base,
        role: 'viewer',
        toolName: 'register_domain',
        policy,
        tldsInArgs: ['com'],
      }).decision,
    ).toBe('deny');
  });

  it('property: cap decision is monotonic in estimated cost', () => {
    const policy: PolicyDoc = {
      ...DEFAULT_POLICY,
      spend_caps: { window: 'month', limit_eur: 100 },
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20000 }), (cost) => {
        const d = evaluate({
          ...base,
          toolName: 'register_domain',
          estimatedCostCents: cost,
          policy,
          tldsInArgs: ['com'],
        });
        if (cost <= 10000) return d.decision === 'requires_confirmation';
        return d.decision === 'deny';
      }),
    );
  });
});

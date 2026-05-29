import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveToolMode, isReadTool, evaluate } from './engine.js';
import { ruleFor, type PolicyDoc } from './schema.js';

/**
 * Builds a minimal but valid PolicyDoc for fuzz testing.
 * - Read tools (list_*, get_*, check_*, suggest_*) → 'allow'
 * - register_domain → 'confirm'  (non-read, billable, triggers spend gate)
 * - trade_domain    → 'confirm'  (non-read write)
 * - delete_domain   → 'confirm'  (non-read write)
 * - create_contact  → 'allow'    (non-read write — not in a wildcard prefix)
 */
function basePolicy(limitEur: number): PolicyDoc {
  return {
    version: 1,
    spend_caps: { window: 'month', limit_eur: limitEur },
    tld_allowlist: [],
    tld_denylist: [],
    ip_allowlist: [],
    tools: {
      'list_*': 'allow',
      'get_*': 'allow',
      'check_*': 'allow',
      'suggest_*': 'allow',
      register_domain: 'confirm',
      trade_domain: 'confirm',
      delete_domain: 'confirm',
      create_contact: 'allow',
    },
  };
}

const toolArb = fc.constantFrom(
  'list_domains',
  'get_domain',
  'check_domain',
  'suggest_domain',
  'register_domain',
  'create_dns_zone',
  'delete_domain',
  'create_ssl_order',
  'create_contact',
  'trade_domain',
);

describe('policy engine — properties', () => {
  it('viewer and auditor never get a non-read tool approved', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        toolArb,
        fc.constantFrom('viewer' as const, 'auditor' as const),
        (lim, tool, role) => {
          if (!isReadTool(tool)) {
            expect(resolveToolMode(basePolicy(lim), tool, role)).toBe('deny');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('evaluate denies over-cap billable tools for operator role', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.nat(200_000),
        fc.integer({ min: 1, max: 200_000 }),
        (lim, live, est) => {
          const d = evaluate({
            toolName: 'register_domain',
            args: {},
            role: 'operator',
            policy: basePolicy(lim),
            liveSpendCents: live,
            estimatedCostCents: est,
            tldsInArgs: [],
          });
          if (live + est > Math.round(lim * 100)) {
            expect(d).toMatchObject({ decision: 'deny', reason: 'spend_cap_exceeded' });
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('ruleFor resolves longest-prefix wildcard (get_secret_* beats get_*)', () => {
    const p = {
      version: 1,
      spend_caps: { window: 'month' as const, limit_eur: 0 },
      tld_allowlist: [],
      tld_denylist: [],
      ip_allowlist: [],
      tools: {
        'get_*': 'allow',
        'get_secret_*': 'confirm',
      },
    } satisfies PolicyDoc;

    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{0,8}$/), (suffix) => {
        expect(ruleFor(p, `get_secret_${suffix}`)).toBe('confirm');
      }),
      { numRuns: 200 },
    );
  });
});

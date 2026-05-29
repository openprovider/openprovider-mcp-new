import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { redactContactPii } from './redact.js';

const SENSITIVE = [
  'secret_key',
  'username',
  'auth_type',
  'api_access_enabled',
  'password_changed_at',
  'last_login_at',
];

/**
 * Builds an arbitrary contact record that always has `id` (so the single-contact
 * heuristic in redactContactPii triggers), plus all sensitive fields so the
 * redaction invariant is meaningful on every run.
 */
const contactArb = fc.record(
  {
    id: fc.integer(),
    email: fc.string(),
    name: fc.record({ first_name: fc.string(), last_name: fc.string() }),
    secret_key: fc.string(),
    username: fc.string(),
    auth_type: fc.string(),
    api_access_enabled: fc.boolean(),
    password_changed_at: fc.string(),
    last_login_at: fc.string(),
  },
  { requiredKeys: ['id'] },
);

describe('redactContactPii — properties', () => {
  it('never emits a sensitive key on a single contact', () => {
    fc.assert(
      fc.property(contactArb, (c) => {
        const out = redactContactPii(c) as Record<string, unknown>;
        for (const k of SENSITIVE) {
          expect(out).not.toHaveProperty(k);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is idempotent on a single contact', () => {
    fc.assert(
      fc.property(contactArb, (c) => {
        const once = redactContactPii(c);
        expect(redactContactPii(once)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });

  it('redacts every entry in a results envelope', () => {
    fc.assert(
      fc.property(fc.array(contactArb, { maxLength: 6 }), (arr) => {
        const out = redactContactPii({ results: arr, total: arr.length }) as {
          results: Record<string, unknown>[];
        };
        for (const r of out.results) {
          for (const k of SENSITIVE) {
            expect(r).not.toHaveProperty(k);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never emits a sensitive key on a bare array of contacts', () => {
    fc.assert(
      fc.property(fc.array(contactArb, { maxLength: 6 }), (arr) => {
        const out = redactContactPii(arr) as Record<string, unknown>[];
        for (const r of out) {
          for (const k of SENSITIVE) {
            expect(r).not.toHaveProperty(k);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

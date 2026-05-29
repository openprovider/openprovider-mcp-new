import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { canonicalArgsHash } from './repo.js';

describe('canonicalArgsHash — properties', () => {
  it('is key-order independent (hash ignores insertion order of keys)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.uuid(), (obj, tenantId) => {
        const a = canonicalArgsHash(obj, tenantId);
        const reordered = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalArgsHash(reordered, tenantId).equals(a)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('different tenant salts produce different hashes for any non-empty object', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { minKeys: 1 }), (obj) => {
        const hashA = canonicalArgsHash(obj, 'tenant-a');
        const hashB = canonicalArgsHash(obj, 'tenant-b');
        expect(hashA.equals(hashB)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('same args + same tenant always produces the same hash (deterministic)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.uuid(), (obj, tenantId) => {
        const h1 = canonicalArgsHash(obj, tenantId);
        const h2 = canonicalArgsHash(obj, tenantId);
        expect(h1.equals(h2)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

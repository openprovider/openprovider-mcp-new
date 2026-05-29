import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createPricing } from './index.js';
import { clientWith } from './__fixtures/op-client.js';

describe('pricing — properties', () => {
  it('register_domain EUR price is a non-negative integer (cents)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 9999, noNaN: true }),
        fc.integer({ min: 1, max: 10 }),
        async (price, period) => {
          const pricing = createPricing({ client: clientWith({ price, currency: 'EUR' }) });
          const cents = await pricing.price(
            'register_domain',
            { domain: { name: 'x', extension: 'com' }, period },
            'tok',
          );
          expect(Number.isInteger(cents)).toBe(true);
          expect(cents).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-EUR currency always throws unsupported_currency', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('USD', 'GBP', 'JPY'), async (currency) => {
        const pricing = createPricing({ client: clientWith({ price: 10, currency }) });
        await expect(
          pricing.price(
            'register_domain',
            { domain: { name: 'x', extension: 'com' }, period: 1 },
            'tok',
          ),
        ).rejects.toMatchObject({ code: 'unsupported_currency' });
      }),
      { numRuns: 30 },
    );
  });

  it('unmapped tools always return 0 cents', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('list_domains', 'get_domain', 'check_domain', 'suggest_domain'),
        async (toolName) => {
          const pricing = createPricing({ client: clientWith({ price: 100, currency: 'EUR' }) });
          const cents = await pricing.price(toolName, {}, 'tok');
          expect(cents).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

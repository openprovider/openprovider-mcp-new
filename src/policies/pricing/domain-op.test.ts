import { describe, expect, it, vi } from 'vitest';
import { createPricing } from './index.js';
import { clientWith } from './__fixtures/op-client.js';

function clientWithDomainPrice(price: { price: number; currency: string }, isPremium = false) {
  const c = clientWith(undefined);
  c.getDomainPrice = vi.fn().mockResolvedValue({
    price: { product: price, reseller: price },
    is_premium: isPremium,
  });
  return c;
}

describe('pricing — domain-op (renew/transfer/restore)', () => {
  it('prices renew_domain in cents from getDomainPrice', async () => {
    const client = clientWithDomainPrice({ price: 9.99, currency: 'EUR' });
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'renew_domain',
      { id: 1, period: 1, domain: { name: 'x', extension: 'com' } },
      'tok',
    );
    expect(cents).toBe(999);
    expect(client.getDomainPrice).toHaveBeenCalledWith('tok', {
      domain: { name: 'x', extension: 'com' },
      operation: 'renew',
    });
  });

  it('prices transfer_domain via the transfer operation (period defaults to 1)', async () => {
    const client = clientWithDomainPrice({ price: 5, currency: 'EUR' });
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'transfer_domain',
      { domain: { name: 'x', extension: 'com' }, auth_code: 'a', owner_handle: 'H' },
      'tok',
    );
    expect(cents).toBe(500);
    expect(client.getDomainPrice).toHaveBeenCalledWith('tok', {
      domain: { name: 'x', extension: 'com' },
      operation: 'transfer',
    });
  });

  it('prices restore_domain via the restore operation', async () => {
    const client = clientWithDomainPrice({ price: 80, currency: 'EUR' });
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'restore_domain',
      { id: 1, domain: { name: 'x', extension: 'com' } },
      'tok',
    );
    expect(cents).toBe(8000);
    expect(client.getDomainPrice).toHaveBeenCalledWith('tok', {
      domain: { name: 'x', extension: 'com' },
      operation: 'restore',
    });
  });

  it('multiplies by period for renew', async () => {
    const client = clientWithDomainPrice({ price: 10, currency: 'EUR' });
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'renew_domain',
      { id: 1, period: 3, domain: { name: 'x', extension: 'com' } },
      'tok',
    );
    expect(cents).toBe(3000);
  });

  it('caches by operation+extension+period (one upstream call for two)', async () => {
    const client = clientWithDomainPrice({ price: 10, currency: 'EUR' });
    const pricing = createPricing({ client });
    await pricing.price(
      'renew_domain',
      { id: 1, period: 1, domain: { name: 'a', extension: 'com' } },
      'tok',
    );
    await pricing.price(
      'renew_domain',
      { id: 2, period: 1, domain: { name: 'b', extension: 'com' } },
      'tok',
    );
    expect(client.getDomainPrice).toHaveBeenCalledTimes(1);
  });

  it('caches separately per operation', async () => {
    const client = clientWithDomainPrice({ price: 10, currency: 'EUR' });
    const pricing = createPricing({ client });
    await pricing.price(
      'renew_domain',
      { id: 1, period: 1, domain: { name: 'a', extension: 'com' } },
      'tok',
    );
    await pricing.price(
      'transfer_domain',
      { domain: { name: 'a', extension: 'com' }, auth_code: 'a', owner_handle: 'H' },
      'tok',
    );
    expect(client.getDomainPrice).toHaveBeenCalledTimes(2);
  });

  it('bypasses cache when is_premium is true', async () => {
    const client = clientWithDomainPrice({ price: 200, currency: 'EUR' }, true);
    const pricing = createPricing({ client });
    await pricing.price(
      'renew_domain',
      { id: 1, period: 1, domain: { name: 'a', extension: 'com' } },
      'tok',
    );
    await pricing.price(
      'renew_domain',
      { id: 1, period: 1, domain: { name: 'a', extension: 'com' } },
      'tok',
    );
    expect(client.getDomainPrice).toHaveBeenCalledTimes(2);
  });

  it('throws unsupported_currency for non-EUR', async () => {
    const client = clientWithDomainPrice({ price: 5, currency: 'USD' });
    const pricing = createPricing({ client });
    await expect(
      pricing.price(
        'renew_domain',
        { id: 1, period: 1, domain: { name: 'x', extension: 'com' } },
        'tok',
      ),
    ).rejects.toMatchObject({ code: 'unsupported_currency' });
  });

  it('trade_domain is NOT priced (stays 0, confirm-without-spend)', async () => {
    const client = clientWithDomainPrice({ price: 10, currency: 'EUR' });
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'trade_domain',
      { domain: { name: 'x', extension: 'com' }, auth_code: 'a', owner_handle: 'H' },
      'tok',
    );
    expect(cents).toBe(0);
    expect(client.getDomainPrice).not.toHaveBeenCalled();
  });
});

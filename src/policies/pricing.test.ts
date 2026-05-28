import { describe, expect, it, vi } from 'vitest';
import { createPricing, DRIFT_TOLERANCE } from './pricing.js';

function clientWith(price: { price: number; currency: string } | undefined, isPremium = false) {
  return {
    checkDomain: vi.fn().mockResolvedValue({
      results: [
        {
          domain: 'x.com',
          status: 'free',
          is_premium: isPremium,
          price: price ? { product: price } : undefined,
        },
      ],
    }),
    listDomains: vi.fn(),
    getDomain: vi.fn(),
    listContacts: vi.fn(),
    getContact: vi.fn(),
    registerDomain: vi.fn(),
    updateDomain: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
    suggestDomain: vi.fn(),
    getDomainAuthcode: vi.fn(),
    resetDomainAuthcode: vi.fn(),
    approveDomainTransfer: vi.fn(),
    sendFoa1DomainTransfer: vi.fn(),
    deleteDomain: vi.fn(),
    restartDomainOperation: vi.fn(),
    renewDomain: vi.fn(),
    transferDomain: vi.fn(),
    tradeDomain: vi.fn(),
    restoreDomain: vi.fn(),
    listDnsZones: vi.fn(),
    getDnsZone: vi.fn(),
    listDnsZoneRecords: vi.fn(),
    listNameservers: vi.fn(),
    getNameserver: vi.fn(),
    listNsGroups: vi.fn(),
    getNsGroup: vi.fn(),
    listDnsTemplates: vi.fn(),
    getDnsTemplate: vi.fn(),
    createDnsZone: vi.fn(),
    updateDnsZone: vi.fn(),
    createNameserver: vi.fn(),
    updateNameserver: vi.fn(),
    createNsGroup: vi.fn(),
    updateNsGroup: vi.fn(),
    createDnsTemplate: vi.fn(),
    createDomainToken: vi.fn(),
    deleteDnsZone: vi.fn(),
    deleteNameserver: vi.fn(),
    deleteNsGroup: vi.fn(),
    deleteDnsTemplate: vi.fn(),
    listTlds: vi.fn(),
    getTld: vi.fn(),
    getDomainPrice: vi.fn(),
    listTags: vi.fn(),
    createTag: vi.fn(),
    deleteTag: vi.fn(),
  };
}

describe('pricing', () => {
  it('prices register_domain in cents from check_domain', async () => {
    const client = clientWith({ price: 12.99, currency: 'EUR' });
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'register_domain',
      { domain: { name: 'x', extension: 'com' }, period: 1 },
      'tok',
    );
    expect(cents).toBe(1299);
  });

  it('returns 0 for non-billable confirm tools', async () => {
    const pricing = createPricing({ client: clientWith(undefined) });
    expect(await pricing.price('delete_contact', { id: 1 }, 'tok')).toBe(0);
  });

  it('throws unsupported_currency for non-EUR', async () => {
    const pricing = createPricing({ client: clientWith({ price: 5, currency: 'USD' }) });
    await expect(
      pricing.price(
        'register_domain',
        { domain: { name: 'x', extension: 'com' }, period: 1 },
        'tok',
      ),
    ).rejects.toMatchObject({ code: 'unsupported_currency' });
  });

  it('caches standard TLD prices (one upstream call for two prices)', async () => {
    const client = clientWith({ price: 10, currency: 'EUR' });
    const pricing = createPricing({ client });
    await pricing.price(
      'register_domain',
      { domain: { name: 'a', extension: 'com' }, period: 1 },
      'tok',
    );
    await pricing.price(
      'register_domain',
      { domain: { name: 'b', extension: 'com' }, period: 1 },
      'tok',
    );
    expect(client.checkDomain).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache for premium domains', async () => {
    const client = clientWith({ price: 999, currency: 'EUR' }, true);
    const pricing = createPricing({ client });
    await pricing.price(
      'register_domain',
      { domain: { name: 'a', extension: 'com' }, period: 1 },
      'tok',
    );
    await pricing.price(
      'register_domain',
      { domain: { name: 'a', extension: 'com' }, period: 1 },
      'tok',
    );
    expect(client.checkDomain).toHaveBeenCalledTimes(2);
  });

  it('exposes a 5% drift tolerance', () => {
    expect(DRIFT_TOLERANCE).toBeCloseTo(0.05);
  });
});

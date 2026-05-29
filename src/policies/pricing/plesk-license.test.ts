import { describe, expect, it, vi } from 'vitest';
import { createPricing } from './index.js';
import { clientWith } from './__fixtures/op-client.js';

function clientWithLicenseCatalog(items: unknown) {
  const c = clientWith(undefined);
  c.listLicensePrices = vi
    .fn()
    .mockResolvedValue({ results: items, total: (items as unknown[]).length });
  return c;
}

const SKU_VPS_WEB = {
  sku: 'PLESK-12-VPS-WEB-ADMIN-1M',
  prices: [
    {
      period: 1,
      price: { product: { currency: 'EUR', price: 8 }, reseller: { currency: 'EUR', price: 7 } },
    },
    {
      period: 12,
      price: { product: { currency: 'EUR', price: 80 }, reseller: { currency: 'EUR', price: 70 } },
    },
  ],
};
const SKU_DEDICATED = {
  sku: 'PLESK-12-DEDICATED-HOST-1M',
  prices: [
    {
      period: 1,
      price: { product: { currency: 'EUR', price: 20 }, reseller: { currency: 'EUR', price: 18 } },
    },
  ],
};

const MINIMAL_BODY = {
  items: ['PLESK-12-VPS-WEB-ADMIN-1M'],
  period: 1,
  ip_address_binding: '127.0.0.1',
  title: 'T',
};

describe('pricing — plesk-license (create)', () => {
  it('prices create_plesk_license per single SKU at the right period', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB, SKU_DEDICATED]);
    const pricing = createPricing({ client });
    const cents = await pricing.price('create_plesk_license', MINIMAL_BODY, 'tok');
    expect(cents).toBe(800);
  });

  it('sums multiple SKUs', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB, SKU_DEDICATED]);
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'create_plesk_license',
      { ...MINIMAL_BODY, items: ['PLESK-12-VPS-WEB-ADMIN-1M', 'PLESK-12-DEDICATED-HOST-1M'] },
      'tok',
    );
    expect(cents).toBe(800 + 2000);
  });

  it('picks the correct period entry', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB]);
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'create_plesk_license',
      { ...MINIMAL_BODY, period: 12 },
      'tok',
    );
    expect(cents).toBe(8000);
  });

  it('caches the catalog (one upstream call for two prices)', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB]);
    const pricing = createPricing({ client });
    await pricing.price('create_plesk_license', MINIMAL_BODY, 'tok');
    await pricing.price('create_plesk_license', { ...MINIMAL_BODY, period: 12 }, 'tok');
    expect(client.listLicensePrices).toHaveBeenCalledTimes(1);
  });

  it('throws unknown_license_sku when sku not in catalog', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB]);
    const pricing = createPricing({ client });
    await expect(
      pricing.price('create_plesk_license', { ...MINIMAL_BODY, items: ['BOGUS-SKU'] }, 'tok'),
    ).rejects.toMatchObject({ code: 'unknown_license_sku' });
  });

  it('throws unsupported_period when sku has no entry for period', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB]);
    const pricing = createPricing({ client });
    await expect(
      pricing.price('create_plesk_license', { ...MINIMAL_BODY, period: 99 }, 'tok'),
    ).rejects.toMatchObject({ code: 'unsupported_period' });
  });

  it('throws unsupported_currency for non-EUR', async () => {
    const usdSku = {
      sku: SKU_VPS_WEB.sku,
      prices: [
        {
          period: 1,
          price: {
            product: { currency: 'USD', price: 8 },
            reseller: { currency: 'USD', price: 7 },
          },
        },
      ],
    };
    const client = clientWithLicenseCatalog([usdSku]);
    const pricing = createPricing({ client });
    await expect(pricing.price('create_plesk_license', MINIMAL_BODY, 'tok')).rejects.toMatchObject({
      code: 'unsupported_currency',
    });
  });

  it('update_plesk_license / delete_plesk_license are NOT priced', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB]);
    const pricing = createPricing({ client });
    expect(await pricing.price('update_plesk_license', MINIMAL_BODY, 'tok')).toBe(0);
    expect(await pricing.price('delete_plesk_license', { key_id: 1 }, 'tok')).toBe(0);
    expect(client.listLicensePrices).not.toHaveBeenCalled();
  });
});

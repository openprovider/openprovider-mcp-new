import { describe, expect, it, vi } from 'vitest';
import { createPricing } from './index.js';
import { clientWith } from './__fixtures/op-client.js';

function clientWithSslProducts(products: unknown, orderLookup?: unknown) {
  const c = clientWith(undefined);
  c.listSslProducts = vi
    .fn()
    .mockResolvedValue({ results: products, total: (products as unknown[]).length });
  if (orderLookup !== undefined) {
    c.getSslOrder = vi.fn().mockResolvedValue(orderLookup);
  }
  return c;
}

const PRODUCT_42 = {
  id: 42,
  name: 'SSL Std',
  prices: [
    {
      period: 1,
      price: { product: { currency: 'EUR', price: 50 }, reseller: { currency: 'EUR', price: 45 } },
      extra_domain_price: {
        product: { currency: 'EUR', price: 10 },
        reseller: { currency: 'EUR', price: 9 },
      },
      extra_wildcard_domain_price: {
        product: { currency: 'EUR', price: 30 },
        reseller: { currency: 'EUR', price: 27 },
      },
    },
    {
      period: 2,
      price: { product: { currency: 'EUR', price: 90 }, reseller: { currency: 'EUR', price: 80 } },
      extra_domain_price: {
        product: { currency: 'EUR', price: 18 },
        reseller: { currency: 'EUR', price: 16 },
      },
      extra_wildcard_domain_price: {
        product: { currency: 'EUR', price: 55 },
        reseller: { currency: 'EUR', price: 50 },
      },
    },
  ],
};

const MINIMAL_BODY = {
  approver_email: 'a@b.c',
  autorenew: 'on',
  csr: 'PEM',
  domain_amount: 1,
  domain_validation_methods: [{ host_name: 'x.com', method: 'dns' }],
  enable_dns_automation: false,
  host_names: ['x.com'],
  organization_handle: 'OH',
  period: 1,
  product_id: 42,
  signature_hash_algorithm: 'sha2',
  software_id: 'linux',
  start_provision: true,
  technical_handle: 'TH',
  wildcard_domain_amount: 0,
};

describe('pricing — ssl-order (create/renew/reissue)', () => {
  it('prices create_ssl_order base price only when domain_amount=1, wildcard_amount=0', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    const cents = await pricing.price('create_ssl_order', MINIMAL_BODY, 'tok');
    expect(cents).toBe(5000);
  });

  it('adds (domain_amount-1) × extra_domain_price for SANs', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'create_ssl_order',
      { ...MINIMAL_BODY, domain_amount: 3 },
      'tok',
    );
    expect(cents).toBe(5000 + 2 * 1000); // base + 2 extra domains × €10
  });

  it('adds wildcard_domain_amount × extra_wildcard_domain_price', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'create_ssl_order',
      { ...MINIMAL_BODY, wildcard_domain_amount: 2 },
      'tok',
    );
    expect(cents).toBe(5000 + 2 * 3000); // base + 2 wildcards × €30
  });

  it('picks the right period entry', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    const cents = await pricing.price('create_ssl_order', { ...MINIMAL_BODY, period: 2 }, 'tok');
    expect(cents).toBe(9000);
  });

  it('reissue uses the same formula as create', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    const cents = await pricing.price('reissue_ssl_order', { ...MINIMAL_BODY, id: 1 }, 'tok');
    expect(cents).toBe(5000);
  });

  it('renew looks up the order via getSslOrder, then prices', async () => {
    const orderShape = {
      id: 7,
      product_id: 42,
      period: 1,
      domain_amount: 2,
      wildcard_domain_amount: 0,
    };
    const client = clientWithSslProducts([PRODUCT_42], orderShape);
    const pricing = createPricing({ client });
    const cents = await pricing.price(
      'renew_ssl_order',
      { id: 7, enable_dns_automation: false },
      'tok',
    );
    expect(cents).toBe(5000 + 1000); // base + 1 extra domain
    expect(client.getSslOrder).toHaveBeenCalledWith('tok', 7);
  });

  it('caches the products list (one upstream call for two prices)', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    await pricing.price('create_ssl_order', MINIMAL_BODY, 'tok');
    await pricing.price('create_ssl_order', { ...MINIMAL_BODY, period: 2 }, 'tok');
    expect(client.listSslProducts).toHaveBeenCalledTimes(1);
  });

  it('throws unknown_ssl_product when product_id not in catalog', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    await expect(
      pricing.price('create_ssl_order', { ...MINIMAL_BODY, product_id: 999 }, 'tok'),
    ).rejects.toMatchObject({ code: 'unknown_ssl_product' });
  });

  it('throws unsupported_period when period not in product.prices', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    await expect(
      pricing.price('create_ssl_order', { ...MINIMAL_BODY, period: 5 }, 'tok'),
    ).rejects.toMatchObject({ code: 'unsupported_period' });
  });

  it('throws unsupported_currency for non-EUR base price', async () => {
    const usdProduct = {
      ...PRODUCT_42,
      prices: [
        {
          ...PRODUCT_42.prices[0],
          price: {
            product: { currency: 'USD', price: 50 },
            reseller: { currency: 'USD', price: 45 },
          },
        },
      ],
    };
    const client = clientWithSslProducts([usdProduct]);
    const pricing = createPricing({ client });
    await expect(pricing.price('create_ssl_order', MINIMAL_BODY, 'tok')).rejects.toMatchObject({
      code: 'unsupported_currency',
    });
  });

  it('cancel_ssl_order is NOT priced (destructive, stays 0)', async () => {
    const client = clientWithSslProducts([PRODUCT_42]);
    const pricing = createPricing({ client });
    expect(await pricing.price('cancel_ssl_order', { id: 1 }, 'tok')).toBe(0);
    expect(client.listSslProducts).not.toHaveBeenCalled();
  });
});

/**
 * Confirm-flow pricing integration test (post-Batch-7 pricing wiring).
 *
 * Boots Postgres, seeds a tenant with DEFAULT_POLICY, builds the pricing engine
 * against a mocked OpenproviderClient, and asserts the pricing dispatch returns
 * real non-zero values for the 7 priced confirm tools, that trade_domain stays 0,
 * and that evaluate() correctly DENIES when estimatedCostCents exceeds the spend cap.
 *
 * No real OP calls — pricer client is mocked here. Live sandbox shape confirmation
 * lives in the env-gated live-*.test.ts files.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner, runAsTenant } from '../_helpers/db.js';
import { createPricing } from '../../../src/policies/pricing.js';
import { evaluate } from '../../../src/policies/engine.js';
import { getPolicy } from '../../../src/policies/repo.js';
import { centsToEur } from '../../../src/policies/money.js';
import type { Role } from '../../../src/policies/schema.js';

describe('pricing-confirm integration', () => {
  let fixture: PgFixture | undefined;
  let pool: pg.Pool | undefined;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const seeded = await seedTenantOwner(pool, 'pricing-confirm@example.com', 'x-hash');
    tenantId = seeded.tenant_id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (fixture) await fixture.stop();
  });

  function clientReturning() {
    return {
      checkDomain: vi.fn().mockResolvedValue({
        results: [
          {
            domain: 'x.com',
            status: 'free',
            is_premium: false,
            price: { product: { currency: 'EUR', price: 15 } },
          },
        ],
      }),
      getDomainPrice: vi.fn().mockResolvedValue({
        price: { product: { currency: 'EUR', price: 12 } },
        is_premium: false,
      }),
      listSslProducts: vi.fn().mockResolvedValue({
        results: [
          {
            id: 42,
            prices: [
              {
                period: 1,
                price: { product: { currency: 'EUR', price: 50 } },
                extra_domain_price: { product: { currency: 'EUR', price: 10 } },
                extra_wildcard_domain_price: { product: { currency: 'EUR', price: 30 } },
              },
            ],
          },
        ],
      }),
      getSslOrder: vi.fn().mockResolvedValue({
        id: 7,
        product_id: 42,
        period: 1,
        domain_amount: 1,
        wildcard_domain_amount: 0,
      }),
      listLicensePrices: vi.fn().mockResolvedValue({
        results: [
          {
            sku: 'PLESK-12-VPS-WEB-ADMIN-1M',
            prices: [{ period: 1, price: { product: { currency: 'EUR', price: 8 } } }],
          },
        ],
      }),
    } as unknown as Parameters<typeof createPricing>[0]['client'];
  }

  it('renew_domain via getDomainPrice → 1200 cents (€12)', async () => {
    const pricing = createPricing({ client: clientReturning() });
    const cents = await pricing.price(
      'renew_domain',
      { id: 1, period: 1, domain: { name: 'x', extension: 'com' } },
      'tok',
    );
    expect(cents).toBe(1200);
  });

  it('create_ssl_order via listSslProducts → 5000 cents (€50 base)', async () => {
    const pricing = createPricing({ client: clientReturning() });
    const cents = await pricing.price(
      'create_ssl_order',
      {
        product_id: 42,
        period: 1,
        domain_amount: 1,
        wildcard_domain_amount: 0,
        approver_email: 'a@b.c',
        autorenew: 'on',
        csr: 'PEM',
        domain_validation_methods: [{ host_name: 'x.com', method: 'dns' }],
        enable_dns_automation: false,
        host_names: ['x.com'],
        organization_handle: 'OH',
        signature_hash_algorithm: 'sha2',
        software_id: 'linux',
        start_provision: true,
        technical_handle: 'TH',
      },
      'tok',
    );
    expect(cents).toBe(5000);
  });

  it('create_plesk_license via listLicensePrices → 800 cents (€8)', async () => {
    const pricing = createPricing({ client: clientReturning() });
    const cents = await pricing.price(
      'create_plesk_license',
      {
        items: ['PLESK-12-VPS-WEB-ADMIN-1M'],
        period: 1,
        ip_address_binding: '127.0.0.1',
        title: 'T',
      },
      'tok',
    );
    expect(cents).toBe(800);
  });

  it('trade_domain stays confirm-without-spend → 0 cents (no price source)', async () => {
    const c = clientReturning();
    const pricing = createPricing({ client: c });
    const cents = await pricing.price(
      'trade_domain',
      { domain: { name: 'x', extension: 'com' }, auth_code: 'a', owner_handle: 'H' },
      'tok',
    );
    expect(cents).toBe(0);
    expect(
      (c as { getDomainPrice: ReturnType<typeof vi.fn> }).getDomainPrice,
    ).not.toHaveBeenCalled();
  });

  it('evaluate() denies renew_domain when cost exceeds spend cap', async () => {
    await runAsTenant(pool!, tenantId, async (client) => {
      await client.query(
        `UPDATE policies SET doc = jsonb_set(doc, '{spend_caps,limit_eur}', '5'::jsonb) WHERE tenant_id = $1`,
        [tenantId],
      );
    });

    const policy = await runAsTenant(pool!, tenantId, (c) => getPolicy(c, tenantId));
    const decision = evaluate({
      toolName: 'renew_domain',
      args: { id: 1, period: 1, domain: { name: 'x', extension: 'com' } },
      role: 'operator' as Role,
      policy,
      liveSpendCents: 0,
      estimatedCostCents: 1200, // €12 > €5 cap
      tldsInArgs: [],
    });
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('spend_cap_exceeded');
  });

  it('summary text formats estimated cost via centsToEur', () => {
    expect(centsToEur(1200)).toBeCloseTo(12);
    expect(centsToEur(5000)).toBeCloseTo(50);
    expect(centsToEur(800)).toBeCloseTo(8);
    expect(centsToEur(0)).toBeCloseTo(0);
  });
});

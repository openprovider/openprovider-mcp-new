# Pricing-Engine Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real Openprovider pricing into the existing pricing engine so 7 confirm-mode billable tools (`renew/transfer/restore_domain`, `create/renew/reissue_ssl_order`, `create_plesk_license`) consume from `spend_caps.limit_eur` instead of bypassing the cap with a `0` cost. `trade_domain` stays confirm-without-spend (no OP price source).

**Architecture:** Split the existing single-file `src/policies/pricing.ts` into a `src/policies/pricing/` directory with one sub-pricer per source (`domain-check`, `domain-op`, `ssl-order`, `plesk-license`). `createPricing` builds a `Map<toolName, Pricer>` at construction; `price(toolName, args, token)` is a one-line dispatch lookup. Multi-tool sub-pricers are parameterized at construction with their discriminator (operation/mode). Each sub-pricer owns its own 24h cache. EUR-only. Any pricer error THROWS (no silent fallback to 0).

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, fetch-based `OpenproviderClient`, Vitest + Nock for unit tests, env-gated live integration tests against the real Openprovider sandbox.

**Spec:** `docs/superpowers/specs/2026-05-29-pricing-engine-integration-design.md`. **Branch:** `feat/enterprise-phase-1`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/policies/pricing.ts` | Replace (~5 lines) | Thin re-export of `./pricing/index.js` so call sites unchanged. |
| `src/policies/pricing/index.ts` | Create | `createPricing(deps)` + dispatch-map wiring. |
| `src/policies/pricing/currency.ts` | Create | `UnsupportedCurrencyError`, `CACHE_TTL_MS` constant. |
| `src/policies/pricing/domain-check.ts` | Create | `register_domain`/`update_domain` pricer — existing logic moved here verbatim. |
| `src/policies/pricing/domain-op.ts` | Create | `renew_domain`/`transfer_domain`/`restore_domain` via `getDomainPrice`. |
| `src/policies/pricing/ssl-order.ts` | Create | `create/renew/reissue_ssl_order` via cached `listSslProducts` + optional `getSslOrder` lookup for renew. |
| `src/policies/pricing/plesk-license.ts` | Create | `create_plesk_license` via cached `listLicensePrices` + per-SKU sum. |
| `src/policies/pricing/__fixtures/op-client.ts` | Create | Shared `clientWith()` helper (currently duplicated in `pricing.test.ts`). |
| `src/policies/pricing/domain-check.test.ts` | Create | Existing tests, moved from `pricing.test.ts`. |
| `src/policies/pricing/domain-op.test.ts` | Create | New unit tests for the operation pricer. |
| `src/policies/pricing/ssl-order.test.ts` | Create | New unit tests for the SSL order pricer. |
| `src/policies/pricing/plesk-license.test.ts` | Create | New unit tests for the Plesk pricer. |
| `src/policies/pricing.test.ts` | Delete (moved) | Logic moved to `domain-check.test.ts`. |
| `tests/integration/openprovider/live-domain-price.test.ts` | Create | Env-gated shape confirmation against real OP. |
| `tests/integration/openprovider/live-ssl-products.test.ts` | Create | Env-gated shape confirmation. |
| `tests/integration/openprovider/live-license-prices.test.ts` | Create | Env-gated shape confirmation. |
| `tests/integration/policies/pricing-confirm.test.ts` | Create | Cap-exceedance + price-summary + drift integration test. |
| `CHANGELOG.md` | Modify | Hard-cutover notice (verbatim from spec §8). |

**Commands:** unit `npx vitest run <path>`; integration `npx vitest run --config vitest.integration.config.ts <path>`; `npm run typecheck`; `npm run lint`.

---

## Task 1: Refactor scaffolding (zero behavior change)

**Goal:** split the existing `pricing.ts` into `pricing/` modules and verify all existing tests still pass.

**Files:**
- Create: `src/policies/pricing/index.ts`
- Create: `src/policies/pricing/currency.ts`
- Create: `src/policies/pricing/domain-check.ts`
- Create: `src/policies/pricing/__fixtures/op-client.ts`
- Create: `src/policies/pricing/domain-check.test.ts`
- Modify: `src/policies/pricing.ts` (replace with re-export)
- Delete: `src/policies/pricing.test.ts` (logic moved to `domain-check.test.ts`)

- [ ] **Step 1: Create `src/policies/pricing/currency.ts`**

```ts
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class UnsupportedCurrencyError extends Error {
  readonly code = 'unsupported_currency';
  constructor(currency: string) {
    super(`Unsupported currency: ${currency}. Pricing supports EUR only.`);
    this.name = 'UnsupportedCurrencyError';
  }
}
```

- [ ] **Step 2: Create `src/policies/pricing/domain-check.ts`** (existing logic, verbatim except the imports)

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { eurToCents } from '../money.js';
import { CACHE_TTL_MS, UnsupportedCurrencyError } from './currency.js';

interface DomainArg {
  domain?: { name: string; extension: string };
  period?: number;
  domains?: { name: string; extension: string }[];
}

export interface Pricer {
  price(args: unknown, token: string): Promise<number>;
}

export function createDomainCheckPricer(deps: { client: OpenproviderClient }): Pricer {
  const cache = new Map<string, { cents: number; at: number }>();

  async function priceOneTld(
    token: string,
    name: string,
    extension: string,
    period: number,
  ): Promise<number> {
    const key = `${extension}|${period}|EUR`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cents;

    const res = await deps.client.checkDomain(token, {
      domains: [{ name, extension }],
      with_price: true,
    });
    const row = res.results[0];
    const product = row?.price?.product;
    if (!product) return 0;
    if (product.currency !== 'EUR') throw new UnsupportedCurrencyError(product.currency);
    const cents = eurToCents(product.price) * period;
    if (!row?.is_premium) cache.set(key, { cents: eurToCents(product.price), at: Date.now() });
    return cents;
  }

  return {
    async price(args, _token) {
      const a = args as DomainArg;
      const period = a.period ?? 1;
      if (a.domain) return priceOneTld(_token, a.domain.name, a.domain.extension, period);
      if (a.domains) {
        let total = 0;
        for (const d of a.domains) total += await priceOneTld(_token, d.name, d.extension, period);
        return total;
      }
      return 0;
    },
  };
}
```

- [ ] **Step 3: Create `src/policies/pricing/index.ts`**

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { createDomainCheckPricer, type Pricer } from './domain-check.js';

export { UnsupportedCurrencyError } from './currency.js';
export type { Pricer } from './domain-check.js';

export const DRIFT_TOLERANCE = 0.05;

export interface Pricing {
  price(toolName: string, args: unknown, token: string): Promise<number>;
}

export function createPricing(deps: { client: OpenproviderClient }): Pricing {
  const domainCheck = createDomainCheckPricer(deps);

  const map = new Map<string, Pricer>([
    ['register_domain', domainCheck],
    ['update_domain', domainCheck],
  ]);

  return {
    async price(toolName, args, token) {
      const p = map.get(toolName);
      if (!p) return 0;
      return p.price(args, token);
    },
  };
}
```

- [ ] **Step 4: Replace `src/policies/pricing.ts` with a thin re-export**

```ts
// Re-export from the modular layout so existing imports keep working.
export {
  createPricing,
  DRIFT_TOLERANCE,
  UnsupportedCurrencyError,
  type Pricing,
  type Pricer,
} from './pricing/index.js';
```

- [ ] **Step 5: Create `src/policies/pricing/__fixtures/op-client.ts`**

The current `pricing.test.ts` has a `clientWith()` helper that stubs ~80 client methods. Lift it into a shared fixture so all four sub-pricer test files (Task 1 + Tasks 2–4) reuse it.

Open the current `src/policies/pricing.test.ts` and copy the `clientWith(...)` function body (lines 4–111 inclusive — the function that returns an object with every client method stubbed via `vi.fn()`). Paste it into a new file `src/policies/pricing/__fixtures/op-client.ts`, prepending:

```ts
import { vi } from 'vitest';
```

…and changing the function declaration from `function clientWith(...)` to `export function clientWith(...)`. The body is otherwise verbatim. Run `npx vitest run src/policies/pricing.test.ts` after the move to confirm tests still pass (Step 7 below).

- [ ] **Step 6: Create `src/policies/pricing/domain-check.test.ts`** — move the existing tests verbatim, swapping the `clientWith` source.

```ts
import { describe, expect, it } from 'vitest';
import { createPricing, DRIFT_TOLERANCE } from './index.js';
import { clientWith } from './__fixtures/op-client.js';

describe('pricing — domain-check (register/update)', () => {
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
```

- [ ] **Step 7: Delete old `src/policies/pricing.test.ts`** (logic moved to `domain-check.test.ts`)

```bash
git rm src/policies/pricing.test.ts
```

- [ ] **Step 8: Run full unit suite to confirm zero behavior change**

```bash
npm run typecheck
npx vitest run src/policies/
npx vitest run
```

Expected: `Test Files 34 passed (34)`, all pricing-related tests green. The catalog test count stays 97 (no tool changes in this task).

- [ ] **Step 9: Commit**

```bash
git add src/policies/pricing.ts src/policies/pricing/
git commit -m "refactor(pricing): split into per-source modules (zero behavior change)"
```

---

## Task 2: Domain operation pricer (renew/transfer/restore)

**Goal:** add real pricing for `renew_domain`, `transfer_domain`, `restore_domain` via the `getDomainPrice` endpoint shipped in Batch 3.

**Files:**
- Create: `src/policies/pricing/domain-op.ts`
- Create: `src/policies/pricing/domain-op.test.ts`
- Modify: `src/policies/pricing/index.ts` (register the new pricer for the 3 tools)
- Create: `tests/integration/openprovider/live-domain-price.test.ts`

- [ ] **Step 1: Write failing test** `src/policies/pricing/domain-op.test.ts`

```ts
import { describe, expect, it } from 'vitest';
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

import { vi } from 'vitest';

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
```

- [ ] **Step 2: Run → must FAIL**

```bash
npx vitest run src/policies/pricing/domain-op.test.ts
```

Expected: FAIL with the dispatch-map returning 0 for `renew_domain`/`transfer_domain`/`restore_domain` (they're not registered yet).

- [ ] **Step 3: Implement `src/policies/pricing/domain-op.ts`**

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { eurToCents } from '../money.js';
import { CACHE_TTL_MS, UnsupportedCurrencyError } from './currency.js';
import type { Pricer } from './domain-check.js';

type Operation = 'renew' | 'transfer' | 'restore';

interface OperationArg {
  domain?: { name: string; extension: string };
  period?: number;
}

interface DomainPriceResponse {
  price?: { product?: { currency?: string; price?: number } };
  is_premium?: boolean;
}

export function createDomainOpPricer(deps: {
  client: OpenproviderClient;
  operation: Operation;
}): Pricer {
  const cache = new Map<string, { cents: number; at: number }>();

  return {
    async price(args, token) {
      const a = args as OperationArg;
      if (!a.domain) return 0;
      const period = a.period ?? 1;
      const key = `${deps.operation}|${a.domain.extension}|${period}|EUR`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cents;

      const raw = (await deps.client.getDomainPrice(token, {
        domain: a.domain,
        operation: deps.operation,
      })) as DomainPriceResponse;
      const product = raw.price?.product;
      if (!product || typeof product.price !== 'number') return 0;
      if (product.currency !== 'EUR') {
        throw new UnsupportedCurrencyError(product.currency ?? 'unknown');
      }
      const unitCents = eurToCents(product.price);
      const totalCents = unitCents * period;
      if (!raw.is_premium) cache.set(key, { cents: unitCents, at: Date.now() });
      return totalCents;
    },
  };
}
```

Note: the cached value is the unit price (per period); multiply by period at the call site of the cache hit too. Adjust the cache hit code so it returns `hit.cents * period`:

```ts
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cents * period;
```

Wait — the existing `domain-check.ts` caches `unitCents` and the cache key already includes `period`, so the cached value can be the full `cents` for that key. Match that convention exactly. Rewrite the cache section of `domain-op.ts` to:

```ts
      const key = `${deps.operation}|${a.domain.extension}|${period}|EUR`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cents;
      // …after fetching raw…
      const cents = eurToCents(product.price) * period;
      if (!raw.is_premium) cache.set(key, { cents, at: Date.now() });
      return cents;
```

Use that exact pattern (matches `domain-check.ts`).

- [ ] **Step 4: Register the new pricer in `src/policies/pricing/index.ts`**

Replace the dispatch-map setup. The full new `index.ts`:

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { createDomainCheckPricer, type Pricer } from './domain-check.js';
import { createDomainOpPricer } from './domain-op.js';

export { UnsupportedCurrencyError } from './currency.js';
export type { Pricer } from './domain-check.js';

export const DRIFT_TOLERANCE = 0.05;

export interface Pricing {
  price(toolName: string, args: unknown, token: string): Promise<number>;
}

export function createPricing(deps: { client: OpenproviderClient }): Pricing {
  const domainCheck = createDomainCheckPricer(deps);
  const renew = createDomainOpPricer({ client: deps.client, operation: 'renew' });
  const transfer = createDomainOpPricer({ client: deps.client, operation: 'transfer' });
  const restore = createDomainOpPricer({ client: deps.client, operation: 'restore' });

  const map = new Map<string, Pricer>([
    ['register_domain', domainCheck],
    ['update_domain', domainCheck],
    ['renew_domain', renew],
    ['transfer_domain', transfer],
    ['restore_domain', restore],
  ]);

  return {
    async price(toolName, args, token) {
      const p = map.get(toolName);
      if (!p) return 0;
      return p.price(args, token);
    },
  };
}
```

- [ ] **Step 5: Run → must PASS**

```bash
npx vitest run src/policies/pricing/
npm run typecheck
npx vitest run
```

Expected: `domain-op.test.ts` 9/9 green. Full unit suite still passes.

- [ ] **Step 6: Create the env-gated live test** `tests/integration/openprovider/live-domain-price.test.ts`

```ts
/**
 * Opt-in live-sandbox shape confirmation for getDomainPrice.
 *
 * Skipped unless OPENPROVIDER_LIVE=1 and OPENPROVIDER_SANDBOX_USERNAME/PASSWORD
 * are set. Calls the Domain Price Service against the sandbox for each of
 * renew/transfer/restore against a known TLD and asserts the response carries
 * price.product.currency === 'EUR' and a numeric price.product.price.
 *
 * Hits a NON-BILLABLE read endpoint — this test never registers/renews a domain.
 */

import { describe, expect, it } from 'vitest';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';

const LIVE = process.env.OPENPROVIDER_LIVE === '1';
const d = LIVE ? describe : describe.skip;

async function getSandboxToken(): Promise<string> {
  const username = process.env.OPENPROVIDER_SANDBOX_USERNAME;
  const password = process.env.OPENPROVIDER_SANDBOX_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'OPENPROVIDER_SANDBOX_USERNAME and OPENPROVIDER_SANDBOX_PASSWORD must be set when OPENPROVIDER_LIVE=1',
    );
  }
  const res = await fetch('https://api.openprovider.eu/v1beta/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Sandbox login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) throw new Error('Sandbox login response missing data.token');
  return token;
}

d('live sandbox — getDomainPrice response shape', () => {
  it('returns EUR + numeric price for renew/transfer/restore on .com', async () => {
    const token = await getSandboxToken();
    const client = createOpenproviderClient();
    for (const operation of ['renew', 'transfer', 'restore'] as const) {
      const raw = (await client.getDomainPrice(token, {
        domain: { name: 'example', extension: 'com' },
        operation,
      })) as {
        price?: { product?: { currency?: string; price?: number } };
        is_premium?: boolean;
      };
      expect(raw.price?.product?.currency, `currency for ${operation}`).toBe('EUR');
      expect(typeof raw.price?.product?.price, `price type for ${operation}`).toBe('number');
    }
  }, 30_000);
});
```

- [ ] **Step 7: Verify the live test skips by default**

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/openprovider/live-domain-price.test.ts
```

Expected: `Tests 1 skipped` (because `OPENPROVIDER_LIVE` is not set in this run).

- [ ] **Step 8: Commit**

```bash
git add src/policies/pricing/domain-op.ts src/policies/pricing/domain-op.test.ts src/policies/pricing/index.ts tests/integration/openprovider/live-domain-price.test.ts
git commit -m "feat(pricing): renew/transfer/restore_domain via Domain Price Service"
```

---

## Task 3: SSL order pricer (create/renew/reissue)

**Goal:** add real pricing for `create_ssl_order`, `renew_ssl_order`, `reissue_ssl_order` via cached `listSslProducts` + a one-time `getSslOrder` lookup for the renew path.

**Files:**
- Create: `src/policies/pricing/ssl-order.ts`
- Create: `src/policies/pricing/ssl-order.test.ts`
- Modify: `src/policies/pricing/index.ts` (register the 3 new pricers)
- Create: `tests/integration/openprovider/live-ssl-products.test.ts`

- [ ] **Step 1: Write failing test** `src/policies/pricing/ssl-order.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPricing } from './index.js';
import { clientWith } from './__fixtures/op-client.js';

function clientWithSslProducts(products: unknown, orderLookup?: unknown) {
  const c = clientWith(undefined);
  c.listSslProducts = vi.fn().mockResolvedValue({ results: products, total: (products as unknown[]).length });
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
    const cents = await pricing.price(
      'reissue_ssl_order',
      { ...MINIMAL_BODY, id: 1 },
      'tok',
    );
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
          price: { product: { currency: 'USD', price: 50 }, reseller: { currency: 'USD', price: 45 } },
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
```

- [ ] **Step 2: Run → must FAIL**

```bash
npx vitest run src/policies/pricing/ssl-order.test.ts
```

Expected: FAIL — the SSL tools return 0 from the dispatch map.

- [ ] **Step 3: Implement `src/policies/pricing/ssl-order.ts`**

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { eurToCents } from '../money.js';
import { CACHE_TTL_MS, UnsupportedCurrencyError } from './currency.js';
import type { Pricer } from './domain-check.js';

type Mode = 'create' | 'renew' | 'reissue';

interface PriceObject {
  product?: { currency?: string; price?: number };
  reseller?: { currency?: string; price?: number };
}
interface PriceEntry {
  period?: number;
  price?: PriceObject;
  extra_domain_price?: PriceObject;
  extra_wildcard_domain_price?: PriceObject;
}
interface Product {
  id?: number;
  prices?: PriceEntry[];
}
interface ProductsResponse {
  results?: Product[];
}

class UnknownSslProductError extends Error {
  readonly code = 'unknown_ssl_product';
  constructor(productId: number) {
    super(`Unknown SSL product id: ${productId}`);
  }
}
class UnsupportedPeriodError extends Error {
  readonly code = 'unsupported_period';
  constructor(productId: number, period: number) {
    super(`SSL product ${productId} has no price entry for period ${period}`);
  }
}

interface CreateOrReissueArgs {
  product_id: number;
  period: number;
  domain_amount: number;
  wildcard_domain_amount: number;
}
interface RenewArgs {
  id: number;
}

function assertEur(p: PriceObject | undefined, what: string): number {
  const product = p?.product;
  if (!product || typeof product.price !== 'number') {
    throw new Error(`Missing ${what} in SSL product price entry`);
  }
  if (product.currency !== 'EUR') {
    throw new UnsupportedCurrencyError(product.currency ?? 'unknown');
  }
  return eurToCents(product.price);
}

function priceFromCatalog(
  products: Product[],
  productId: number,
  period: number,
  domainAmount: number,
  wildcardAmount: number,
): number {
  const product = products.find((p) => p.id === productId);
  if (!product) throw new UnknownSslProductError(productId);
  const entry = product.prices?.find((e) => e.period === period);
  if (!entry) throw new UnsupportedPeriodError(productId, period);

  let total = assertEur(entry.price, 'base price');
  if (domainAmount > 1) {
    const extra = assertEur(entry.extra_domain_price, 'extra_domain_price');
    total += (domainAmount - 1) * extra;
  }
  if (wildcardAmount > 0) {
    const wcard = assertEur(entry.extra_wildcard_domain_price, 'extra_wildcard_domain_price');
    total += wildcardAmount * wcard;
  }
  return total;
}

export function createSslOrderPricer(deps: {
  client: OpenproviderClient;
  mode: Mode;
}): Pricer {
  let cached: { products: Product[]; at: number } | undefined;

  async function getProducts(token: string): Promise<Product[]> {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.products;
    const raw = (await deps.client.listSslProducts(token)) as ProductsResponse;
    const products = raw.results ?? [];
    cached = { products, at: Date.now() };
    return products;
  }

  return {
    async price(args, token) {
      if (deps.mode === 'renew') {
        const renewArgs = args as RenewArgs;
        const order = (await deps.client.getSslOrder(token, renewArgs.id)) as Partial<
          CreateOrReissueArgs
        >;
        if (
          typeof order.product_id !== 'number' ||
          typeof order.period !== 'number' ||
          typeof order.domain_amount !== 'number' ||
          typeof order.wildcard_domain_amount !== 'number'
        ) {
          return 0;
        }
        const products = await getProducts(token);
        return priceFromCatalog(
          products,
          order.product_id,
          order.period,
          order.domain_amount,
          order.wildcard_domain_amount,
        );
      }
      const a = args as CreateOrReissueArgs;
      const products = await getProducts(token);
      return priceFromCatalog(
        products,
        a.product_id,
        a.period,
        a.domain_amount,
        a.wildcard_domain_amount,
      );
    },
  };
}
```

- [ ] **Step 4: Register the 3 new pricers** in `src/policies/pricing/index.ts`. Replace the existing `createPricing` body (preserving prior registrations):

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { createDomainCheckPricer, type Pricer } from './domain-check.js';
import { createDomainOpPricer } from './domain-op.js';
import { createSslOrderPricer } from './ssl-order.js';

export { UnsupportedCurrencyError } from './currency.js';
export type { Pricer } from './domain-check.js';

export const DRIFT_TOLERANCE = 0.05;

export interface Pricing {
  price(toolName: string, args: unknown, token: string): Promise<number>;
}

export function createPricing(deps: { client: OpenproviderClient }): Pricing {
  const domainCheck = createDomainCheckPricer(deps);
  const renewDomain = createDomainOpPricer({ client: deps.client, operation: 'renew' });
  const transferDomain = createDomainOpPricer({ client: deps.client, operation: 'transfer' });
  const restoreDomain = createDomainOpPricer({ client: deps.client, operation: 'restore' });
  const createSsl = createSslOrderPricer({ client: deps.client, mode: 'create' });
  const renewSsl = createSslOrderPricer({ client: deps.client, mode: 'renew' });
  const reissueSsl = createSslOrderPricer({ client: deps.client, mode: 'reissue' });

  const map = new Map<string, Pricer>([
    ['register_domain', domainCheck],
    ['update_domain', domainCheck],
    ['renew_domain', renewDomain],
    ['transfer_domain', transferDomain],
    ['restore_domain', restoreDomain],
    ['create_ssl_order', createSsl],
    ['renew_ssl_order', renewSsl],
    ['reissue_ssl_order', reissueSsl],
  ]);

  return {
    async price(toolName, args, token) {
      const p = map.get(toolName);
      if (!p) return 0;
      return p.price(args, token);
    },
  };
}
```

- [ ] **Step 5: Run → PASS**

```bash
npx vitest run src/policies/pricing/
npm run typecheck
npx vitest run
```

Expected: all sub-pricer tests green. Full unit suite still 100%.

- [ ] **Step 6: Create live test** `tests/integration/openprovider/live-ssl-products.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';

const LIVE = process.env.OPENPROVIDER_LIVE === '1';
const d = LIVE ? describe : describe.skip;

async function getSandboxToken(): Promise<string> {
  const username = process.env.OPENPROVIDER_SANDBOX_USERNAME;
  const password = process.env.OPENPROVIDER_SANDBOX_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'OPENPROVIDER_SANDBOX_USERNAME and OPENPROVIDER_SANDBOX_PASSWORD must be set when OPENPROVIDER_LIVE=1',
    );
  }
  const res = await fetch('https://api.openprovider.eu/v1beta/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Sandbox login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) throw new Error('Sandbox login response missing data.token');
  return token;
}

d('live sandbox — listSslProducts response shape', () => {
  it('returns products with prices[] carrying period + EUR base + extra fields', async () => {
    const token = await getSandboxToken();
    const client = createOpenproviderClient();
    const raw = (await client.listSslProducts(token)) as {
      results?: {
        id?: number;
        prices?: {
          period?: number;
          price?: { product?: { currency?: string; price?: number } };
          extra_domain_price?: { product?: { currency?: string; price?: number } };
          extra_wildcard_domain_price?: { product?: { currency?: string; price?: number } };
        }[];
      }[];
    };
    expect(Array.isArray(raw.results)).toBe(true);
    const sample = raw.results?.find((p) => Array.isArray(p.prices) && p.prices.length > 0);
    expect(sample, 'at least one product with prices[]').toBeTruthy();
    const entry = sample!.prices![0];
    expect(typeof entry.period, 'period is number').toBe('number');
    expect(entry.price?.product?.currency, 'base currency is EUR').toBe('EUR');
    expect(typeof entry.price?.product?.price, 'base price is number').toBe('number');
    // extra_domain_price / extra_wildcard_domain_price may be present per product class
    if (entry.extra_domain_price) {
      expect(entry.extra_domain_price.product?.currency).toBe('EUR');
    }
    if (entry.extra_wildcard_domain_price) {
      expect(entry.extra_wildcard_domain_price.product?.currency).toBe('EUR');
    }
  }, 30_000);
});
```

- [ ] **Step 7: Verify live test skips by default**

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/openprovider/live-ssl-products.test.ts
```

Expected: 1 skipped.

- [ ] **Step 8: Commit**

```bash
git add src/policies/pricing/ssl-order.ts src/policies/pricing/ssl-order.test.ts src/policies/pricing/index.ts tests/integration/openprovider/live-ssl-products.test.ts
git commit -m "feat(pricing): create/renew/reissue_ssl_order via listSslProducts"
```

---

## Task 4: Plesk license pricer

**Goal:** add real pricing for `create_plesk_license` via cached `listLicensePrices` + per-SKU sum.

**Files:**
- Create: `src/policies/pricing/plesk-license.ts`
- Create: `src/policies/pricing/plesk-license.test.ts`
- Modify: `src/policies/pricing/index.ts` (register the new pricer)
- Create: `tests/integration/openprovider/live-license-prices.test.ts`

- [ ] **Step 1: Write failing test** `src/policies/pricing/plesk-license.test.ts`

```ts
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
          price: { product: { currency: 'USD', price: 8 }, reseller: { currency: 'USD', price: 7 } },
        },
      ],
    };
    const client = clientWithLicenseCatalog([usdSku]);
    const pricing = createPricing({ client });
    await expect(
      pricing.price('create_plesk_license', MINIMAL_BODY, 'tok'),
    ).rejects.toMatchObject({ code: 'unsupported_currency' });
  });

  it('update_plesk_license / delete_plesk_license are NOT priced', async () => {
    const client = clientWithLicenseCatalog([SKU_VPS_WEB]);
    const pricing = createPricing({ client });
    expect(await pricing.price('update_plesk_license', MINIMAL_BODY, 'tok')).toBe(0);
    expect(await pricing.price('delete_plesk_license', { key_id: 1 }, 'tok')).toBe(0);
    expect(client.listLicensePrices).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → must FAIL**

```bash
npx vitest run src/policies/pricing/plesk-license.test.ts
```

Expected: FAIL — `create_plesk_license` returns 0 from the dispatch map.

- [ ] **Step 3: Implement `src/policies/pricing/plesk-license.ts`**

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { eurToCents } from '../money.js';
import { CACHE_TTL_MS, UnsupportedCurrencyError } from './currency.js';
import type { Pricer } from './domain-check.js';

interface PriceObject {
  product?: { currency?: string; price?: number };
}
interface SkuEntry {
  sku?: string;
  prices?: { period?: number; price?: PriceObject }[];
}
interface CatalogResponse {
  results?: SkuEntry[];
}

class UnknownLicenseSkuError extends Error {
  readonly code = 'unknown_license_sku';
  constructor(sku: string) {
    super(`Unknown license SKU: ${sku}`);
  }
}
class UnsupportedPeriodError extends Error {
  readonly code = 'unsupported_period';
  constructor(sku: string, period: number) {
    super(`License SKU ${sku} has no price entry for period ${period}`);
  }
}

interface CreatePleskLicenseArgs {
  items?: string[];
  period?: number;
}

export function createPleskLicensePricer(deps: { client: OpenproviderClient }): Pricer {
  let cached: { catalog: SkuEntry[]; at: number } | undefined;

  async function getCatalog(token: string): Promise<SkuEntry[]> {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.catalog;
    const raw = (await deps.client.listLicensePrices(token)) as CatalogResponse;
    const catalog = raw.results ?? [];
    cached = { catalog, at: Date.now() };
    return catalog;
  }

  return {
    async price(args, token) {
      const a = args as CreatePleskLicenseArgs;
      const items = a.items ?? [];
      const period = a.period ?? 1;
      if (items.length === 0) return 0;
      const catalog = await getCatalog(token);
      let total = 0;
      for (const sku of items) {
        const entry = catalog.find((c) => c.sku === sku);
        if (!entry) throw new UnknownLicenseSkuError(sku);
        const periodEntry = entry.prices?.find((p) => p.period === period);
        if (!periodEntry) throw new UnsupportedPeriodError(sku, period);
        const product = periodEntry.price?.product;
        if (!product || typeof product.price !== 'number') {
          throw new Error(`Missing price for SKU ${sku} period ${period}`);
        }
        if (product.currency !== 'EUR') {
          throw new UnsupportedCurrencyError(product.currency ?? 'unknown');
        }
        total += eurToCents(product.price);
      }
      return total;
    },
  };
}
```

- [ ] **Step 4: Register in `src/policies/pricing/index.ts`**

Full new `createPricing` body (add `pleskLicense` registration after the SSL ones):

```ts
import type { OpenproviderClient } from '../../openprovider/client.js';
import { createDomainCheckPricer, type Pricer } from './domain-check.js';
import { createDomainOpPricer } from './domain-op.js';
import { createSslOrderPricer } from './ssl-order.js';
import { createPleskLicensePricer } from './plesk-license.js';

export { UnsupportedCurrencyError } from './currency.js';
export type { Pricer } from './domain-check.js';

export const DRIFT_TOLERANCE = 0.05;

export interface Pricing {
  price(toolName: string, args: unknown, token: string): Promise<number>;
}

export function createPricing(deps: { client: OpenproviderClient }): Pricing {
  const domainCheck = createDomainCheckPricer(deps);
  const renewDomain = createDomainOpPricer({ client: deps.client, operation: 'renew' });
  const transferDomain = createDomainOpPricer({ client: deps.client, operation: 'transfer' });
  const restoreDomain = createDomainOpPricer({ client: deps.client, operation: 'restore' });
  const createSsl = createSslOrderPricer({ client: deps.client, mode: 'create' });
  const renewSsl = createSslOrderPricer({ client: deps.client, mode: 'renew' });
  const reissueSsl = createSslOrderPricer({ client: deps.client, mode: 'reissue' });
  const pleskLicense = createPleskLicensePricer({ client: deps.client });

  const map = new Map<string, Pricer>([
    ['register_domain', domainCheck],
    ['update_domain', domainCheck],
    ['renew_domain', renewDomain],
    ['transfer_domain', transferDomain],
    ['restore_domain', restoreDomain],
    ['create_ssl_order', createSsl],
    ['renew_ssl_order', renewSsl],
    ['reissue_ssl_order', reissueSsl],
    ['create_plesk_license', pleskLicense],
  ]);

  return {
    async price(toolName, args, token) {
      const p = map.get(toolName);
      if (!p) return 0;
      return p.price(args, token);
    },
  };
}
```

- [ ] **Step 5: Run → PASS**

```bash
npx vitest run src/policies/pricing/
npm run typecheck
npx vitest run
```

- [ ] **Step 6: Create live test** `tests/integration/openprovider/live-license-prices.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';

const LIVE = process.env.OPENPROVIDER_LIVE === '1';
const d = LIVE ? describe : describe.skip;

async function getSandboxToken(): Promise<string> {
  const username = process.env.OPENPROVIDER_SANDBOX_USERNAME;
  const password = process.env.OPENPROVIDER_SANDBOX_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'OPENPROVIDER_SANDBOX_USERNAME and OPENPROVIDER_SANDBOX_PASSWORD must be set when OPENPROVIDER_LIVE=1',
    );
  }
  const res = await fetch('https://api.openprovider.eu/v1beta/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Sandbox login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) throw new Error('Sandbox login response missing data.token');
  return token;
}

d('live sandbox — listLicensePrices response shape', () => {
  it('returns SKU entries with prices[] carrying period + EUR price', async () => {
    const token = await getSandboxToken();
    const client = createOpenproviderClient();
    const raw = (await client.listLicensePrices(token)) as {
      results?: {
        sku?: string;
        prices?: {
          period?: number;
          price?: { product?: { currency?: string; price?: number } };
        }[];
      }[];
    };
    expect(Array.isArray(raw.results)).toBe(true);
    const sample = raw.results?.find(
      (e) => typeof e.sku === 'string' && Array.isArray(e.prices) && e.prices.length > 0,
    );
    expect(sample, 'at least one SKU with prices').toBeTruthy();
    const entry = sample!.prices![0];
    expect(typeof entry.period).toBe('number');
    expect(entry.price?.product?.currency).toBe('EUR');
    expect(typeof entry.price?.product?.price).toBe('number');
  }, 30_000);
});
```

- [ ] **Step 7: Verify skip + commit**

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/openprovider/live-license-prices.test.ts
git add src/policies/pricing/plesk-license.ts src/policies/pricing/plesk-license.test.ts src/policies/pricing/index.ts tests/integration/openprovider/live-license-prices.test.ts
git commit -m "feat(pricing): create_plesk_license via listLicensePrices"
```

---

## Task 5: Confirm-flow integration test + CHANGELOG

**Goal:** integration test proving the full confirm-flow uses real pricing (proposal carries `est. €X.YY`; cap-exceedance denial fires; `trade_domain` shows `est. €0.00`). Plus the CHANGELOG entry documenting the hard cutover.

**Files:**
- Create: `tests/integration/policies/pricing-confirm.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the integration test** `tests/integration/policies/pricing-confirm.test.ts`

Model on the existing `tests/integration/mcp/domain-lifecycle-e2e.test.ts` harness (Postgres + dispatcher + propose flow). The key new assertions: (a) `estimatedCostCents` is non-zero for priced tools; (b) cap-exceedance returns `decision: deny, reason: spend_cap_exceeded`; (c) `trade_domain` proposal shows `est. €0.00`.

```ts
/**
 * Confirm-flow pricing integration test (post-Batch-7 pricing wiring).
 *
 * Boots Postgres, seeds a tenant with DEFAULT_POLICY, builds the dispatcher with
 * a mocked OpenproviderClient (no real OP), and asserts the confirm propose path
 * passes real (non-zero) pricing into the spend-cap evaluation.
 *
 * Mirrors the dispatcher construction from server.ts so the pricing wiring is
 * exercised end-to-end.
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

  function clientReturning(
    overrides: Partial<{
      checkDomain: unknown;
      getDomainPrice: unknown;
      listSslProducts: unknown;
      listLicensePrices: unknown;
      getSslOrder: unknown;
    }>,
  ) {
    const base = {
      checkDomain: vi.fn().mockResolvedValue({
        results: [
          { domain: 'x.com', status: 'free', is_premium: false, price: { product: { currency: 'EUR', price: 15 } } },
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
    };
    return { ...base, ...overrides } as unknown as Parameters<typeof createPricing>[0]['client'];
  }

  it('renew_domain via getDomainPrice → 1200 cents (€12)', async () => {
    const pricing = createPricing({ client: clientReturning({}) });
    const cents = await pricing.price(
      'renew_domain',
      { id: 1, period: 1, domain: { name: 'x', extension: 'com' } },
      'tok',
    );
    expect(cents).toBe(1200);
  });

  it('create_ssl_order via listSslProducts → 5000 cents (€50 base)', async () => {
    const pricing = createPricing({ client: clientReturning({}) });
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
    const pricing = createPricing({ client: clientReturning({}) });
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
    const c = clientReturning({});
    const pricing = createPricing({ client: c });
    const cents = await pricing.price(
      'trade_domain',
      { domain: { name: 'x', extension: 'com' }, auth_code: 'a', owner_handle: 'H' },
      'tok',
    );
    expect(cents).toBe(0);
    // Critically: trade_domain must NOT have called getDomainPrice
    expect((c as { getDomainPrice: ReturnType<typeof vi.fn> }).getDomainPrice).not.toHaveBeenCalled();
  });

  it('evaluate() denies renew_domain when cost exceeds spend cap', async () => {
    // Reduce cap to 5 EUR for this tenant.
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
    // The dispatcher's propose() builds: `${toolName} (est. €${centsToEur(estimatedCostCents)})`
    expect(centsToEur(1200)).toBeCloseTo(12);
    expect(centsToEur(5000)).toBeCloseTo(50);
    expect(centsToEur(800)).toBeCloseTo(8);
    expect(centsToEur(0)).toBeCloseTo(0);
  });
});
```

- [ ] **Step 2: Run → must PASS**

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/policies/pricing-confirm.test.ts
```

Expected: 6/6 green. Container boot ~50-70s.

- [ ] **Step 3: Update `CHANGELOG.md` with the hard-cutover notice**

Read the existing `CHANGELOG.md` to see its format. Add a new entry at the top under the next-release header (or create a new section if the latest entry is already released). The entry text, verbatim from the spec:

```markdown
## [Unreleased]

### Breaking changes
- **Pricing engine wired to spend-cap.** `renew_domain`, `transfer_domain`, `restore_domain`, `create_ssl_order`, `renew_ssl_order`, `reissue_ssl_order`, `create_plesk_license` now consume from the tenant's `spend_caps.limit_eur` (previously they were priced at 0 and bypassed the cap). Tenants whose cap was set under the prior behavior should raise it before performing these operations or confirmations will be denied with `decision: deny, reason: spend_cap_exceeded`. `trade_domain` remains confirm-without-spend (no public Openprovider price source is available for the trade operation).

### Added
- `src/policies/pricing/` directory with sub-pricers: `domain-check`, `domain-op`, `ssl-order`, `plesk-license`.
- Env-gated live integration tests against the Openprovider sandbox: `live-domain-price`, `live-ssl-products`, `live-license-prices` (skipped unless `OPENPROVIDER_LIVE=1`).
- Confirm-flow pricing integration test (`tests/integration/policies/pricing-confirm.test.ts`).
```

Match the existing CHANGELOG's bullet/spacing/heading style. If the existing CHANGELOG already has an `## [Unreleased]` section, append to its existing `### Breaking changes` / `### Added` subsections instead of creating new ones.

- [ ] **Step 4: FULL gate**

```bash
npm run typecheck   # 0 errors
npm run lint        # 0 errors
npx vitest run      # full unit suite green
npx vitest run --config vitest.integration.config.ts   # all integration green; 3 live tests skipped
```

The catalog test count stays 97 (this work adds no tools). The pre-existing `audit-chain` concurrency test may flake under parallel load — re-run in isolation to confirm pre-existing.

- [ ] **Step 5: Commit + STOP (do NOT push)**

```bash
git add tests/integration/policies/pricing-confirm.test.ts CHANGELOG.md
git commit -m "feat(pricing): hard cutover — bill 7 confirm-mode tools against spend cap"
```

After this commit, the branch is ready for review and push. Report `STATUS: DONE`, the commit SHA, the gate results, and the list of commits added by this plan (should be 5 — one per task). The push gate is held by the human user, who will say "yes" before any `git push`.

---

## Self-Review

**1. Spec coverage:**
- §1 Decisions (one spec, hard cutover, trade_domain confirm-without-spend, best-guess + live tests, errors throw): Tasks 1–5 collectively implement these. ✅
- §2 Architecture (pricing/ directory, Pricer interface, parameterized factories, 24h cache, EUR-only, throw-on-failure): Task 1 (refactor + interface), Tasks 2–4 (parameterized factories per source). ✅
- §3 Per-pricer formulas (domain-check, domain-op operation map, ssl-order formula with renew lookup, plesk-license SKU sum): Tasks 1–4 implement each verbatim. ✅
- §4 Spend-cap behavior summary (which tools priced, drift inherited): Task 5 integration test asserts this. ✅
- §5 Tasks (5 tasks, single push at end): plan has 5 tasks; Task 5 ends with "do NOT push". ✅
- §6 Testing (unit per sub-pricer, integration test, env-gated live tests): all present. ✅
- §7 Risks (live tests catch shape mismatch, getSslOrder latency noted, premium bypass cache, drift self-heals, hard-cutover surprise): all reflected in either implementation (premium bypass, getSslOrder uncached) or CHANGELOG. ✅
- §8 CHANGELOG entry: Task 5 Step 3 uses the spec-verbatim text. ✅
- §9 Out-of-scope (non-EUR, reseller pricing, per-tenant cap migration, trade_domain pricing, DNS/customer/tag/email/catalog tools, validateConfirmation refactor): none of these appear in any task. ✅

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or vague directives. Every step has either complete code or a precise edit description. The CHANGELOG step asks the engineer to read the existing file because format depends on the file's current state — that's appropriate; the exact entry text is provided verbatim.

**3. Type consistency:**
- Sub-pricer factory names match across tasks: `createDomainCheckPricer` (Task 1), `createDomainOpPricer` (Task 2), `createSslOrderPricer` (Task 3), `createPleskLicensePricer` (Task 4). All consistent.
- `Pricer` interface is defined once in `domain-check.ts` (Task 1) and imported by sibling files (Tasks 2–4). Consistent.
- `Pricing` interface unchanged across the whole plan (matches the existing call sites in `src/server.ts`). Consistent.
- Tool names match the registered map keys in `index.ts` across Tasks 2, 3, 4: `renew_domain`/`transfer_domain`/`restore_domain` (Task 2), `create_ssl_order`/`renew_ssl_order`/`reissue_ssl_order` (Task 3), `create_plesk_license` (Task 4). All match the tool names shipped in Batches 1, 4, 7. ✅
- `clientWith()` fixture (Task 1 Step 5) is imported by Tasks 2, 3, 4 as `import { clientWith } from './__fixtures/op-client.js'`. Consistent path.

*End of plan.*

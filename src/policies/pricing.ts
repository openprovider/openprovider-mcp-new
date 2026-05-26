import type { OpenproviderClient } from '../openprovider/client.js';
import { eurToCents } from './money.js';

export const DRIFT_TOLERANCE = 0.05;

class UnsupportedCurrencyError extends Error {
  readonly code = 'unsupported_currency';
  constructor(currency: string) {
    super(`Unsupported currency: ${currency}. Phase 4 supports EUR only.`);
    this.name = 'UnsupportedCurrencyError';
  }
}

const BILLABLE = new Set(['register_domain', 'update_domain']);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface DomainArg {
  domain?: { name: string; extension: string };
  period?: number;
  domains?: { name: string; extension: string }[];
}

export interface Pricing {
  price(toolName: string, args: unknown, token: string): Promise<number>;
}

export function createPricing(deps: { client: OpenproviderClient }): Pricing {
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
    // Premium domains are not cached (price is name-specific, not TLD-generic).
    if (!row?.is_premium) cache.set(key, { cents: eurToCents(product.price), at: Date.now() });
    return cents;
  }

  return {
    async price(toolName, args, token) {
      if (!BILLABLE.has(toolName)) return 0;
      const a = args as DomainArg;
      const period = a.period ?? 1;
      if (a.domain) return priceOneTld(token, a.domain.name, a.domain.extension, period);
      if (a.domains) {
        let total = 0;
        for (const d of a.domains) total += await priceOneTld(token, d.name, d.extension, period);
        return total;
      }
      return 0;
    },
  };
}

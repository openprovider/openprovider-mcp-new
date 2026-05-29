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

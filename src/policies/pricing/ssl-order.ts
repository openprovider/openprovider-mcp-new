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

export function createSslOrderPricer(deps: { client: OpenproviderClient; mode: Mode }): Pricer {
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
        const order = (await deps.client.getSslOrder(
          token,
          renewArgs.id,
        )) as Partial<CreateOrReissueArgs>;
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

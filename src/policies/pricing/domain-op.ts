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
      const cents = eurToCents(product.price) * period;
      if (!raw.is_premium) cache.set(key, { cents, at: Date.now() });
      return cents;
    },
  };
}

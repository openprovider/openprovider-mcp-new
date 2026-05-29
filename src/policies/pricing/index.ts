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

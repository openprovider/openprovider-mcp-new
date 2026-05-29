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

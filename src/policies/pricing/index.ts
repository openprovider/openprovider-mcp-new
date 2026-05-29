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

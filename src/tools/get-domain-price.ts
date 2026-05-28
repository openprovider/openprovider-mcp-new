import { GetDomainPriceArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetDomainPriceTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_domain_price',
    description: 'Get the registration/renew/transfer/restore price for a domain.',
    inputSchema: GetDomainPriceArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = GetDomainPriceArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getDomainPrice(token, parsed);
    },
  };
}

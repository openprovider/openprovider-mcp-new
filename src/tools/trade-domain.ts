import { TradeDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createTradeDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'trade_domain',
    description: 'Trade (change owner of) a domain (billable; requires approval).',
    inputSchema: TradeDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = TradeDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.tradeDomain(token, parsed);
    },
  };
}

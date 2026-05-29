import { RenewSslOrderArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createRenewSslOrderTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'renew_ssl_order',
    description: 'Renew an SSL order (billable; requires approval).',
    inputSchema: RenewSslOrderArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = RenewSslOrderArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.renewSslOrder(token, parsed);
    },
  };
}

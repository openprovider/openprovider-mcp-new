import { CancelSslOrderArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCancelSslOrderTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'cancel_ssl_order',
    description: 'Cancel an SSL order (requires approval).',
    inputSchema: CancelSslOrderArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CancelSslOrderArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.cancelSslOrder(token, parsed);
    },
  };
}

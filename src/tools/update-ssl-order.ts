import { UpdateSslOrderArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdateSslOrderTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'update_ssl_order',
    description: 'Update an SSL order.',
    inputSchema: UpdateSslOrderArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdateSslOrderArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updateSslOrder(token, parsed);
    },
  };
}

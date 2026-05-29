import { SslOrderIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetSslOrderTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_ssl_order',
    description: 'Get SSL order details by id.',
    inputSchema: SslOrderIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = SslOrderIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getSslOrder(token, parsed.id);
    },
  };
}

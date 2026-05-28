import { SslProductIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetSslProductTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_ssl_product',
    description: 'Get SSL product details by id.',
    inputSchema: SslProductIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = SslProductIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getSslProduct(token, parsed.id);
    },
  };
}

import { ReissueSslOrderArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createReissueSslOrderTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'reissue_ssl_order',
    description: 'Reissue an SSL order (billable; requires approval).',
    inputSchema: ReissueSslOrderArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ReissueSslOrderArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.reissueSslOrder(token, parsed);
    },
  };
}

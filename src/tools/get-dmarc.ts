import { GetDmarcArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetDmarcTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_dmarc',
    description: 'Get the EasyDmarc subscription for a domain.',
    inputSchema: GetDmarcArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = GetDmarcArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getDmarc(token, parsed);
    },
  };
}

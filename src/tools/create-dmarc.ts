import { CreateDmarcArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateDmarcTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_dmarc',
    description: 'Create an EasyDmarc subscription for a domain.',
    inputSchema: CreateDmarcArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateDmarcArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createDmarc(token, parsed);
    },
  };
}

import { CreateNameserverArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateNameserverTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_nameserver',
    description: 'Register a nameserver.',
    inputSchema: CreateNameserverArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateNameserverArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createNameserver(token, parsed);
    },
  };
}

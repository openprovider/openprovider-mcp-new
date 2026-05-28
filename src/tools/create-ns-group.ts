import { CreateNsGroupArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateNsGroupTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_ns_group',
    description: 'Create a nameserver group.',
    inputSchema: CreateNsGroupArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateNsGroupArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createNsGroup(token, parsed);
    },
  };
}

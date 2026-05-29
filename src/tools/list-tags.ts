import { NoArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createListTagsTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'list_tags',
    description: 'List tags.',
    inputSchema: NoArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      NoArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.listTags(token);
    },
  };
}

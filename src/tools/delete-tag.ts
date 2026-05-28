import { DeleteTagArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteTagTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_tag',
    description: 'Delete a tag by key/value (requires approval).',
    inputSchema: DeleteTagArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = DeleteTagArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteTag(token, parsed);
    },
  };
}

import { NsGroupNameArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteNsGroupTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_ns_group',
    description: 'Delete a nameserver group (requires approval).',
    inputSchema: NsGroupNameArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = NsGroupNameArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteNsGroup(token, parsed.ns_group);
    },
  };
}

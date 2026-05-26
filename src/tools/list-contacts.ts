import { ListContactsArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createListContactsTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'list_contacts',
    description: "List contacts in the tenant's Openprovider account.",
    inputSchema: ListContactsArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ListContactsArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.listContacts(token, parsed);
    },
  };
}

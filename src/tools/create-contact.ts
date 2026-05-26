import { CreateContactArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateContactTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_contact',
    description: 'Create a new contact (handle) in the tenant’s Openprovider account.',
    inputSchema: CreateContactArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateContactArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createContact(token, parsed);
    },
  };
}

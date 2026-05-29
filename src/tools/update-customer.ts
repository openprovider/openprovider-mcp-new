import { UpdateCustomerArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdateCustomerTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'update_customer',
    description: 'Update a customer (contact).',
    inputSchema: UpdateCustomerArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdateCustomerArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updateCustomer(token, parsed);
    },
  };
}

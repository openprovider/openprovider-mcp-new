import { CreateCustomerArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateCustomerTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_customer',
    description: 'Create a customer (contact).',
    inputSchema: CreateCustomerArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateCustomerArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createCustomer(token, parsed);
    },
  };
}

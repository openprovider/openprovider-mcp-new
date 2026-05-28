import { CustomerHandleArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteCustomerTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_customer',
    description: 'Delete a customer (requires approval).',
    inputSchema: CustomerHandleArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CustomerHandleArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteCustomer(token, parsed.handle);
    },
  };
}

import { CustomerHandleArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';
import { redactContactPii } from '../openprovider/redact.js';

export function createGetCustomerTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_customer',
    description: 'Get customer details by handle.',
    inputSchema: CustomerHandleArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CustomerHandleArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      const raw = await deps.client.getCustomer(token, parsed.handle);
      return redactContactPii(raw);
    },
  };
}

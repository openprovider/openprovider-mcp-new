import { RegisterDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createRegisterDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'register_domain',
    description: 'Register a new domain (billable). Requires an existing owner contact handle.',
    inputSchema: RegisterDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = RegisterDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.registerDomain(token, parsed);
    },
  };
}

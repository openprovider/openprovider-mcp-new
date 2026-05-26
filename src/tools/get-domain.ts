import { GetDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_domain',
    description: 'Get details for one domain by Openprovider domain id.',
    inputSchema: GetDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = GetDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getDomain(token, parsed.id);
    },
  };
}

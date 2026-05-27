import { RenewDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createRenewDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'renew_domain',
    description: 'Renew a domain for N years (billable; requires approval).',
    inputSchema: RenewDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = RenewDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.renewDomain(token, parsed);
    },
  };
}

import { CreateDomainTokenArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateDomainTokenTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_domain_token',
    description: 'Create a DNS domain-control token.',
    inputSchema: CreateDomainTokenArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateDomainTokenArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createDomainToken(token, parsed);
    },
  };
}

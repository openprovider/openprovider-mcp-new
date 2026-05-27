import { SuggestDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createSuggestDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'suggest_domain',
    description: 'Suggest available domain names for a base name across TLDs.',
    inputSchema: SuggestDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = SuggestDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.suggestDomain(token, parsed);
    },
  };
}

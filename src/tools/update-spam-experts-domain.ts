import { UpdateSpamExpertsDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdateSpamExpertsDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'update_spam_experts_domain',
    description: 'Update a SpamExperts domain.',
    inputSchema: UpdateSpamExpertsDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdateSpamExpertsDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updateSpamExpertsDomain(token, parsed);
    },
  };
}

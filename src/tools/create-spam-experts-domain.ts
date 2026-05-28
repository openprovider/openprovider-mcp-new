import { CreateSpamExpertsDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateSpamExpertsDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_spam_experts_domain',
    description: 'Provision a SpamExperts domain.',
    inputSchema: CreateSpamExpertsDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateSpamExpertsDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createSpamExpertsDomain(token, parsed);
    },
  };
}

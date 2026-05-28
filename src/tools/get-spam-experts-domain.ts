import { SpamExpertsDomainArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetSpamExpertsDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_spam_experts_domain',
    description: 'Get a SpamExperts domain configuration.',
    inputSchema: SpamExpertsDomainArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = SpamExpertsDomainArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getSpamExpertsDomain(token, parsed.domain_name);
    },
  };
}

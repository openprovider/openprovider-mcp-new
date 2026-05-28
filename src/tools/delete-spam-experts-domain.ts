import { SpamExpertsDomainArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteSpamExpertsDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_spam_experts_domain',
    description: 'Delete a SpamExperts domain (requires approval).',
    inputSchema: SpamExpertsDomainArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = SpamExpertsDomainArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteSpamExpertsDomain(token, parsed.domain_name);
    },
  };
}

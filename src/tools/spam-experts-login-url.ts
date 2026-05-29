import { SpamExpertsLoginUrlArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createSpamExpertsLoginUrlTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'spam_experts_login_url',
    description: 'Generate a SpamExperts dashboard login URL.',
    inputSchema: SpamExpertsLoginUrlArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = SpamExpertsLoginUrlArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.spamExpertsLoginUrl(token, parsed);
    },
  };
}

import { RetryDmarcArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createRetryDmarcTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'retry_dmarc',
    description: 'Retry an EasyDmarc subscription.',
    inputSchema: RetryDmarcArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = RetryDmarcArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.retryDmarc(token, parsed);
    },
  };
}

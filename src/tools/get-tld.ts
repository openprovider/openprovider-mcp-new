import { TldNameArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetTldTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_tld',
    description: 'Get TLD metadata by name.',
    inputSchema: TldNameArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = TldNameArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getTld(token, parsed.name);
    },
  };
}

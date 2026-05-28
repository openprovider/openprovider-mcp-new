import { EasyDmarcIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteDmarcTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_dmarc',
    description: 'Delete an EasyDmarc subscription (requires approval).',
    inputSchema: EasyDmarcIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = EasyDmarcIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteDmarc(token, parsed.id);
    },
  };
}

import { CreateCsrArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateCsrTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_csr',
    description: 'Generate a CSR.',
    inputSchema: CreateCsrArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateCsrArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createCsr(token, parsed);
    },
  };
}

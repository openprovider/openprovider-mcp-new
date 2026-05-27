import { DomainIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_domain',
    description: 'Delete a domain (destructive; requires approval).',
    inputSchema: DomainIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = DomainIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteDomain(token, parsed.id);
    },
  };
}

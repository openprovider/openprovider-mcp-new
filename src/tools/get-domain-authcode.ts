import { DomainIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetDomainAuthcodeTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_domain_authcode',
    description: 'Get the EPP auth/transfer code for a domain.',
    inputSchema: DomainIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = DomainIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getDomainAuthcode(token, parsed.id);
    },
  };
}

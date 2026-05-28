import { DmarcSsoLoginArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDmarcSsoLoginTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'dmarc_sso_login',
    description: 'Get the EasyDmarc SSO login URL.',
    inputSchema: DmarcSsoLoginArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = DmarcSsoLoginArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.dmarcSsoLogin(token, parsed);
    },
  };
}

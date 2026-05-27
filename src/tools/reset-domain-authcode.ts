import { ResetAuthcodeArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createResetDomainAuthcodeTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'reset_domain_authcode',
    description: "Reset/regenerate a domain's EPP auth code.",
    inputSchema: ResetAuthcodeArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ResetAuthcodeArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.resetDomainAuthcode(token, parsed);
    },
  };
}

import { ResetPleskHwidArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createResetPleskHwidTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'reset_plesk_hwid',
    description: 'Reset the HWID binding of a Plesk license.',
    inputSchema: ResetPleskHwidArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ResetPleskHwidArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.resetPleskHwid(token, parsed);
    },
  };
}

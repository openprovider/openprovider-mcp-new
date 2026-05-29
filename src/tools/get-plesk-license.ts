import { PleskKeyIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetPleskLicenseTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_plesk_license',
    description: 'Get a Plesk license by key id.',
    inputSchema: PleskKeyIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = PleskKeyIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getPleskLicense(token, parsed.key_id);
    },
  };
}

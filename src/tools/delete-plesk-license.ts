import { PleskKeyIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeletePleskLicenseTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_plesk_license',
    description: 'Delete a Plesk license (requires approval).',
    inputSchema: PleskKeyIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = PleskKeyIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deletePleskLicense(token, parsed.key_id);
    },
  };
}

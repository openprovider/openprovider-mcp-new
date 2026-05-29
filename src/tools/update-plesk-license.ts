import { UpdatePleskLicenseArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdatePleskLicenseTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'update_plesk_license',
    description: 'Update a Plesk license.',
    inputSchema: UpdatePleskLicenseArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdatePleskLicenseArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updatePleskLicense(token, parsed);
    },
  };
}

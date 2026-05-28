import { CreatePleskLicenseArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreatePleskLicenseTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_plesk_license',
    description: 'Provision a new Plesk license (billable; requires approval).',
    inputSchema: CreatePleskLicenseArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreatePleskLicenseArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createPleskLicense(token, parsed);
    },
  };
}

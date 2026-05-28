import { ZoneNameArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteDnsZoneTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_dns_zone',
    description: 'Delete a DNS zone (destructive; requires approval).',
    inputSchema: ZoneNameArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ZoneNameArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteDnsZone(token, parsed.name);
    },
  };
}

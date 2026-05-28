import { ZoneNameArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetDnsZoneTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_dns_zone',
    description: 'Get a DNS zone by domain name.',
    inputSchema: ZoneNameArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ZoneNameArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getDnsZone(token, parsed.name);
    },
  };
}

import { CreateDnsZoneArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateDnsZoneTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_dns_zone',
    description: 'Create a DNS zone.',
    inputSchema: CreateDnsZoneArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateDnsZoneArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createDnsZone(token, parsed);
    },
  };
}

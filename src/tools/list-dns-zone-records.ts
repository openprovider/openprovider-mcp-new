import { ZoneNameArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createListDnsZoneRecordsTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'list_dns_zone_records',
    description: 'List the DNS records of a zone.',
    inputSchema: ZoneNameArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ZoneNameArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.listDnsZoneRecords(token, parsed.name);
    },
  };
}

import { GetContactArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';
import { redactContactPii } from '../openprovider/redact.js';

export function createGetContactTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_contact',
    description: 'Get details for one contact by Openprovider contact id.',
    inputSchema: GetContactArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = GetContactArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      const raw = await deps.client.getContact(token, parsed.id);
      return redactContactPii(raw);
    },
  };
}

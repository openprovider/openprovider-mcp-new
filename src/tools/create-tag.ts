import { CreateTagArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateTagTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_tag',
    description: 'Create a tag (key/value pair).',
    inputSchema: CreateTagArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateTagArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createTag(token, parsed);
    },
  };
}

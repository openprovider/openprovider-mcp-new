import { z } from 'zod';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export const DeleteContactArgs = z.object({ id: z.number().int().positive() });

export function createDeleteContactTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_contact',
    description: 'Delete a contact by id (destructive).',
    inputSchema: DeleteContactArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = DeleteContactArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteContact(token, parsed.id);
    },
  };
}

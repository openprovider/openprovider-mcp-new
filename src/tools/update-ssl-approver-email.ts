import { UpdateSslApproverEmailArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdateSslApproverEmailTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'update_ssl_approver_email',
    description: 'Update the approver email of an SSL order.',
    inputSchema: UpdateSslApproverEmailArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdateSslApproverEmailArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updateSslApproverEmail(token, parsed);
    },
  };
}

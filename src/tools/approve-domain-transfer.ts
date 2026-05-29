import { ApproveTransferArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createApproveDomainTransferTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'approve_domain_transfer',
    description: 'Approve an inbound/outbound domain transfer.',
    inputSchema: ApproveTransferArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ApproveTransferArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.approveDomainTransfer(token, parsed);
    },
  };
}

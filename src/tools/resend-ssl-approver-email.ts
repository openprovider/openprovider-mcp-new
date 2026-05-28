import { ResendSslApproverEmailArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createResendSslApproverEmailTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'resend_ssl_approver_email',
    description: 'Resend the approver email for an SSL order.',
    inputSchema: ResendSslApproverEmailArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ResendSslApproverEmailArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.resendSslApproverEmail(token, parsed);
    },
  };
}

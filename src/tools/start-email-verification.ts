import { StartEmailVerificationArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createStartEmailVerificationTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'start_email_verification',
    description: 'Start an email verification flow for a customer.',
    inputSchema: StartEmailVerificationArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = StartEmailVerificationArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.startEmailVerification(token, parsed);
    },
  };
}

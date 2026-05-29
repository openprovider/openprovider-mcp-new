import { RestartEmailVerificationArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createRestartEmailVerificationTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'restart_email_verification',
    description: 'Restart an email verification flow.',
    inputSchema: RestartEmailVerificationArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = RestartEmailVerificationArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.restartEmailVerification(token, parsed);
    },
  };
}

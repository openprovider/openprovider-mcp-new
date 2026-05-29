import { CreateSslOtpTokenArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateSslOtpTokenTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_ssl_otp_token',
    description: 'Create an OTP token for an SSL order.',
    inputSchema: CreateSslOtpTokenArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateSslOtpTokenArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createSslOtpToken(token, parsed);
    },
  };
}

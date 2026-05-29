import { DomainIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createSendFoa1DomainTransferTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'send_foa1_domain_transfer',
    description: 'Send the FOA1 transfer-confirmation email for a domain.',
    inputSchema: DomainIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = DomainIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.sendFoa1DomainTransfer(token, parsed.id);
    },
  };
}

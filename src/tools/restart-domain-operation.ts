import { RestartDomainOperationArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createRestartDomainOperationTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'restart_domain_operation',
    description: 'Restart the last domain operation (may re-bill; requires approval).',
    inputSchema: RestartDomainOperationArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = RestartDomainOperationArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.restartDomainOperation(token, parsed);
    },
  };
}

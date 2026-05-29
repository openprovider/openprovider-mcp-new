import { CreateDnsTemplateArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateDnsTemplateTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_dns_template',
    description: 'Create a DNS template.',
    inputSchema: CreateDnsTemplateArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateDnsTemplateArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createDnsTemplate(token, parsed);
    },
  };
}

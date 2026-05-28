import { TemplateIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetDnsTemplateTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_dns_template',
    description: 'Get a DNS template by id.',
    inputSchema: TemplateIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = TemplateIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getDnsTemplate(token, parsed.id);
    },
  };
}

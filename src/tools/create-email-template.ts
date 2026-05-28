import { CreateEmailTemplateArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateEmailTemplateTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'create_email_template',
    description: 'Create an email template.',
    inputSchema: CreateEmailTemplateArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateEmailTemplateArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createEmailTemplate(token, parsed);
    },
  };
}

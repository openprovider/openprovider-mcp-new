import { UpdateEmailTemplateArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdateEmailTemplateTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'update_email_template',
    description: 'Update an email template.',
    inputSchema: UpdateEmailTemplateArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdateEmailTemplateArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updateEmailTemplate(token, parsed);
    },
  };
}

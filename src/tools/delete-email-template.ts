import { EmailTemplateIdArg } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createDeleteEmailTemplateTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'delete_email_template',
    description: 'Delete an email template (requires approval).',
    inputSchema: EmailTemplateIdArg,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = EmailTemplateIdArg.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteEmailTemplate(token, parsed.id);
    },
  };
}

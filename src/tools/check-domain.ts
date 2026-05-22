import { CheckDomainArgs, type CheckDomainResult } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';
import type { ZodTypeAny } from 'zod';

export interface CheckDomainDeps {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}

export function createCheckDomainTool(deps: CheckDomainDeps): {
  name: 'check_domain';
  description: string;
  inputSchema: ZodTypeAny;
  handler: (args: unknown, principal: Principal) => Promise<CheckDomainResult>;
} {
  return {
    name: 'check_domain',
    description:
      'Check whether one or more domains are available for registration with Openprovider, optionally with prices.',
    inputSchema: CheckDomainArgs,
    handler: async (args, principal) => {
      const parsed = CheckDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.checkDomain(token, parsed);
    },
  };
}

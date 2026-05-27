import type { ToolEntry } from './sdk-transport.js';
import type { DispatcherTool } from './dispatch.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type pg from 'pg';
import { createCheckDomainTool } from '../tools/check-domain.js';
import { createListDomainsTool } from '../tools/list-domains.js';
import { createGetDomainTool } from '../tools/get-domain.js';
import { createListContactsTool } from '../tools/list-contacts.js';
import { createGetContactTool } from '../tools/get-contact.js';
import { createRegisterDomainTool } from '../tools/register-domain.js';
import { createUpdateDomainTool } from '../tools/update-domain.js';
import { createCreateContactTool } from '../tools/create-contact.js';
import { createUpdateContactTool } from '../tools/update-contact.js';
import { createDeleteContactTool } from '../tools/delete-contact.js';
import { createListPendingConfirmationsTool } from '../tools/list-pending-confirmations.js';
import { createConfirmPendingTool } from '../tools/confirm-pending.js';

/**
 * Static tool catalog for tools/list. Built by instantiating each tool factory
 * with stub deps to read its name/description/inputSchema; the handlers here are
 * never called (tools/call is intercepted by the dispatcher fast-path in transport.ts).
 * MUST stay in sync with the dispatchFactory tool list in src/server.ts.
 */
export function buildToolCatalog(): ToolEntry[] {
  // Stub deps: only metadata (name/description/inputSchema) is read at construction time.
  // Handlers close over deps but are never invoked — tools/call is intercepted by the
  // dispatcher fast-path before reaching the SDK CallTool handler.
  const stubClient = undefined as unknown as OpenproviderClient;
  const stubTokenManager = undefined as unknown as OpenproviderTokenManager;
  const stubPgClient = undefined as unknown as pg.PoolClient;

  const listedOnly = (): Promise<unknown> =>
    Promise.reject(new Error('catalog entry is list-only; dispatched via fast-path'));

  const tools: DispatcherTool[] = [
    createCheckDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListDomainsTool({ client: stubClient, tokenManager: stubTokenManager }),
    createGetDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListContactsTool({ client: stubClient, tokenManager: stubTokenManager }),
    createGetContactTool({ client: stubClient, tokenManager: stubTokenManager }),
    createRegisterDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createUpdateDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createCreateContactTool({ client: stubClient, tokenManager: stubTokenManager }),
    createUpdateContactTool({ client: stubClient, tokenManager: stubTokenManager }),
    createDeleteContactTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListPendingConfirmationsTool({ getClient: () => stubPgClient }),
    createConfirmPendingTool({
      consume: () =>
        Promise.reject(new Error('catalog entry is list-only; dispatched via fast-path')),
    }),
  ];

  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    inputSchema: t.inputSchema as any,
    handler: listedOnly,
  }));
}

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
import { createSuggestDomainTool } from '../tools/suggest-domain.js';
import { createGetDomainAuthcodeTool } from '../tools/get-domain-authcode.js';
import { createResetDomainAuthcodeTool } from '../tools/reset-domain-authcode.js';
import { createApproveDomainTransferTool } from '../tools/approve-domain-transfer.js';
import { createSendFoa1DomainTransferTool } from '../tools/send-foa1-domain-transfer.js';
import { createDeleteDomainTool } from '../tools/delete-domain.js';
import { createRestartDomainOperationTool } from '../tools/restart-domain-operation.js';
import { createRenewDomainTool } from '../tools/renew-domain.js';
import { createTransferDomainTool } from '../tools/transfer-domain.js';
import { createTradeDomainTool } from '../tools/trade-domain.js';
import { createRestoreDomainTool } from '../tools/restore-domain.js';
import { createListDnsZonesTool } from '../tools/list-dns-zones.js';
import { createGetDnsZoneTool } from '../tools/get-dns-zone.js';
import { createListDnsZoneRecordsTool } from '../tools/list-dns-zone-records.js';
import { createListNameserversTool } from '../tools/list-nameservers.js';
import { createGetNameserverTool } from '../tools/get-nameserver.js';
import { createListNsGroupsTool } from '../tools/list-ns-groups.js';
import { createGetNsGroupTool } from '../tools/get-ns-group.js';
import { createListDnsTemplatesTool } from '../tools/list-dns-templates.js';
import { createGetDnsTemplateTool } from '../tools/get-dns-template.js';
import { createCreateDnsZoneTool } from '../tools/create-dns-zone.js';
import { createUpdateDnsZoneTool } from '../tools/update-dns-zone.js';
import { createCreateNameserverTool } from '../tools/create-nameserver.js';
import { createUpdateNameserverTool } from '../tools/update-nameserver.js';
import { createCreateNsGroupTool } from '../tools/create-ns-group.js';
import { createUpdateNsGroupTool } from '../tools/update-ns-group.js';
import { createCreateDnsTemplateTool } from '../tools/create-dns-template.js';
import { createCreateDomainTokenTool } from '../tools/create-domain-token.js';
import { createDeleteDnsZoneTool } from '../tools/delete-dns-zone.js';
import { createDeleteNameserverTool } from '../tools/delete-nameserver.js';
import { createDeleteNsGroupTool } from '../tools/delete-ns-group.js';
import { createDeleteDnsTemplateTool } from '../tools/delete-dns-template.js';

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
    createSuggestDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createGetDomainAuthcodeTool({ client: stubClient, tokenManager: stubTokenManager }),
    createResetDomainAuthcodeTool({ client: stubClient, tokenManager: stubTokenManager }),
    createApproveDomainTransferTool({ client: stubClient, tokenManager: stubTokenManager }),
    createSendFoa1DomainTransferTool({ client: stubClient, tokenManager: stubTokenManager }),
    createDeleteDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createRestartDomainOperationTool({ client: stubClient, tokenManager: stubTokenManager }),
    createRenewDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createTransferDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createTradeDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createRestoreDomainTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListDnsZonesTool({ client: stubClient, tokenManager: stubTokenManager }),
    createGetDnsZoneTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListDnsZoneRecordsTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListNameserversTool({ client: stubClient, tokenManager: stubTokenManager }),
    createGetNameserverTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListNsGroupsTool({ client: stubClient, tokenManager: stubTokenManager }),
    createGetNsGroupTool({ client: stubClient, tokenManager: stubTokenManager }),
    createListDnsTemplatesTool({ client: stubClient, tokenManager: stubTokenManager }),
    createGetDnsTemplateTool({ client: stubClient, tokenManager: stubTokenManager }),
    createCreateDnsZoneTool({ client: stubClient, tokenManager: stubTokenManager }),
    createUpdateDnsZoneTool({ client: stubClient, tokenManager: stubTokenManager }),
    createCreateNameserverTool({ client: stubClient, tokenManager: stubTokenManager }),
    createUpdateNameserverTool({ client: stubClient, tokenManager: stubTokenManager }),
    createCreateNsGroupTool({ client: stubClient, tokenManager: stubTokenManager }),
    createUpdateNsGroupTool({ client: stubClient, tokenManager: stubTokenManager }),
    createCreateDnsTemplateTool({ client: stubClient, tokenManager: stubTokenManager }),
    createCreateDomainTokenTool({ client: stubClient, tokenManager: stubTokenManager }),
    createDeleteDnsZoneTool({ client: stubClient, tokenManager: stubTokenManager }),
    createDeleteNameserverTool({ client: stubClient, tokenManager: stubTokenManager }),
    createDeleteNsGroupTool({ client: stubClient, tokenManager: stubTokenManager }),
    createDeleteDnsTemplateTool({ client: stubClient, tokenManager: stubTokenManager }),
  ];

  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    inputSchema: t.inputSchema as any,
    handler: listedOnly,
  }));
}

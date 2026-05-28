import { describe, expect, it, vi } from 'vitest';
import { createListDomainsTool } from './list-domains.js';
import { createGetDomainTool } from './get-domain.js';
import { createListContactsTool } from './list-contacts.js';
import { createGetContactTool } from './get-contact.js';
import type { Principal } from '../auth/principal.js';

const principal: Principal = {
  kind: 'user',
  tenantId: 't1',
  userId: 'u1',
  subject: 's1',
  scopes: [],
  role: 'owner',
};

function deps() {
  return {
    client: {
      checkDomain: vi.fn(),
      listDomains: vi.fn().mockResolvedValue({ results: [{ id: 1 }] }),
      getDomain: vi.fn().mockResolvedValue({ id: 42 }),
      listContacts: vi.fn().mockResolvedValue({ results: [] }),
      getContact: vi.fn().mockResolvedValue({ id: 7 }),
      registerDomain: vi.fn(),
      updateDomain: vi.fn(),
      createContact: vi.fn(),
      updateContact: vi.fn(),
      deleteContact: vi.fn(),
      suggestDomain: vi.fn(),
      getDomainAuthcode: vi.fn(),
      resetDomainAuthcode: vi.fn(),
      approveDomainTransfer: vi.fn(),
      sendFoa1DomainTransfer: vi.fn(),
      deleteDomain: vi.fn(),
      restartDomainOperation: vi.fn(),
      renewDomain: vi.fn(),
      transferDomain: vi.fn(),
      tradeDomain: vi.fn(),
      restoreDomain: vi.fn(),
      listDnsZones: vi.fn(),
      getDnsZone: vi.fn(),
      listDnsZoneRecords: vi.fn(),
      listNameservers: vi.fn(),
      getNameserver: vi.fn(),
      listNsGroups: vi.fn(),
      getNsGroup: vi.fn(),
      listDnsTemplates: vi.fn(),
      getDnsTemplate: vi.fn(),
      createDnsZone: vi.fn(),
      updateDnsZone: vi.fn(),
      createNameserver: vi.fn(),
      updateNameserver: vi.fn(),
      createNsGroup: vi.fn(),
      updateNsGroup: vi.fn(),
      createDnsTemplate: vi.fn(),
      createDomainToken: vi.fn(),
      deleteDnsZone: vi.fn(),
      deleteNameserver: vi.fn(),
      deleteNsGroup: vi.fn(),
      deleteDnsTemplate: vi.fn(),
      listTlds: vi.fn(),
      getTld: vi.fn(),
      getDomainPrice: vi.fn(),
      listTags: vi.fn(),
      createTag: vi.fn(),
      deleteTag: vi.fn(),
    },
    tokenManager: { getToken: vi.fn().mockResolvedValue('jwt'), invalidate: vi.fn() },
  };
}

describe('read tools', () => {
  it('list_domains fetches token then calls client.listDomains', async () => {
    const d = deps();
    const tool = createListDomainsTool(d);
    const r = (await tool.handler({ limit: 100, offset: 0 }, principal)) as { results: unknown[] };
    expect(r.results).toHaveLength(1);
    expect(d.tokenManager.getToken).toHaveBeenCalledWith('t1');
  });

  it('get_domain passes the id through', async () => {
    const d = deps();
    const tool = createGetDomainTool(d);
    await tool.handler({ id: 42 }, principal);
    expect(d.client.getDomain).toHaveBeenCalledWith('jwt', 42);
  });

  it('list_contacts and get_contact call their client methods', async () => {
    const d = deps();
    await createListContactsTool(d).handler({ limit: 100, offset: 0 }, principal);
    await createGetContactTool(d).handler({ id: 7 }, principal);
    expect(d.client.listContacts).toHaveBeenCalled();
    expect(d.client.getContact).toHaveBeenCalledWith('jwt', 7);
  });

  it('get_domain rejects a non-positive id at the schema', async () => {
    const tool = createGetDomainTool(deps());
    await expect(tool.handler({ id: 0 }, principal)).rejects.toThrow();
  });
});

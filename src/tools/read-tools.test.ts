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

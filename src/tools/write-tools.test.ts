import { describe, expect, it, vi } from 'vitest';
import { createRegisterDomainTool } from './register-domain.js';
import { createUpdateDomainTool } from './update-domain.js';
import { createCreateContactTool } from './create-contact.js';
import { createUpdateContactTool } from './update-contact.js';
import { createDeleteContactTool } from './delete-contact.js';
import type { Principal } from '../auth/principal.js';

const principal: Principal = {
  kind: 'user',
  tenantId: 't1',
  userId: 'u',
  subject: 's',
  scopes: [],
  role: 'owner',
};

function deps() {
  return {
    client: {
      checkDomain: vi.fn(),
      listDomains: vi.fn(),
      getDomain: vi.fn(),
      listContacts: vi.fn(),
      getContact: vi.fn(),
      registerDomain: vi.fn().mockResolvedValue({ id: 99 }),
      updateDomain: vi.fn().mockResolvedValue({ id: 42 }),
      createContact: vi.fn().mockResolvedValue({ handle: 'XY' }),
      updateContact: vi.fn().mockResolvedValue({ handle: 'XY' }),
      deleteContact: vi.fn().mockResolvedValue({ success: true }),
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
      listSslProducts: vi.fn(),
      getSslProduct: vi.fn(),
      listSslOrders: vi.fn(),
      getSslOrder: vi.fn(),
      getSslApproverEmails: vi.fn(),
      createSslOrder: vi.fn(),
      renewSslOrder: vi.fn(),
      reissueSslOrder: vi.fn(),
      cancelSslOrder: vi.fn(),
      updateSslOrder: vi.fn(),
      updateSslApproverEmail: vi.fn(),
      resendSslApproverEmail: vi.fn(),
      createCsr: vi.fn(),
      decodeCsr: vi.fn(),
      createSslOtpToken: vi.fn(),
      listCustomers: vi.fn(),
      getCustomer: vi.fn(),
      createCustomer: vi.fn(),
      updateCustomer: vi.fn(),
      deleteCustomer: vi.fn(),
    },
    tokenManager: { getToken: vi.fn().mockResolvedValue('jwt'), invalidate: vi.fn() },
  };
}

describe('write tools', () => {
  it('register_domain gets token then calls client.registerDomain', async () => {
    const d = deps();
    const r = (await createRegisterDomainTool(d).handler(
      { domain: { name: 'a', extension: 'com' }, period: 1, owner_handle: 'AB' },
      principal,
    )) as { id: number };
    expect(r.id).toBe(99);
    expect(d.tokenManager.getToken).toHaveBeenCalledWith('t1');
  });
  it('update_domain passes id from args', async () => {
    const d = deps();
    await createUpdateDomainTool(d).handler({ id: 42, autorenew: 'on' }, principal);
    expect(d.client.updateDomain).toHaveBeenCalledWith(
      'jwt',
      42,
      expect.objectContaining({ id: 42 }),
    );
  });
  it('create_contact calls client.createContact', async () => {
    const d = deps();
    await createCreateContactTool(d).handler(
      {
        name: { first_name: 'A', last_name: 'B' },
        phone: { country_code: '+1', subscriber_number: '5551234' },
        address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
      },
      principal,
    );
    expect(d.client.createContact).toHaveBeenCalled();
  });
  it('update_contact + delete_contact call their methods', async () => {
    const d = deps();
    await createUpdateContactTool(d).handler({ id: 7, email: 'a@b.co' }, principal);
    await createDeleteContactTool(d).handler({ id: 7 }, principal);
    expect(d.client.updateContact).toHaveBeenCalledWith(
      'jwt',
      7,
      expect.objectContaining({ id: 7 }),
    );
    expect(d.client.deleteContact).toHaveBeenCalledWith('jwt', 7);
  });
  it('register_domain rejects period 0 at the schema', async () => {
    await expect(
      createRegisterDomainTool(deps()).handler(
        { domain: { name: 'a', extension: 'com' }, period: 0, owner_handle: 'AB' },
        principal,
      ),
    ).rejects.toThrow();
  });
});

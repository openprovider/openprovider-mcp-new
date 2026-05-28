import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { createOpenproviderClient } from './client.js';
import {
  OpenproviderAuthError,
  OpenproviderClientError,
  OpenproviderUnavailableError,
} from './errors.js';

describe('openprovider client — check_domain', () => {
  afterEach(() => nock.cleanAll());

  it('parses a 200 response with a price', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(200, {
        data: {
          results: [
            {
              domain: 'example.com',
              status: 'free',
              is_premium: false,
              price: { product: { price: 9.99, currency: 'EUR' } },
            },
          ],
        },
      });
    const client = createOpenproviderClient();
    const r = await client.checkDomain('tok', {
      domains: [{ name: 'example', extension: 'com' }],
      with_price: true,
    });
    expect(r.results[0]?.domain).toBe('example.com');
    expect(r.results[0]?.price?.product?.price).toBe(9.99);
  });

  it('throws OpenproviderAuthError on 401', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(401, { error: 'bad token' });
    const client = createOpenproviderClient();
    await expect(
      client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
    ).rejects.toBeInstanceOf(OpenproviderAuthError);
  });

  it('retries on 5xx then succeeds', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(503);
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(200, {
        data: { results: [{ domain: 'x.com', status: 'free' }] },
      });
    const client = createOpenproviderClient();
    const r = await client.checkDomain('tok', {
      domains: [{ name: 'x', extension: 'com' }],
      with_price: false,
    });
    expect(r.results[0]?.status).toBe('free');
  }, 10_000);

  it('throws OpenproviderUnavailableError after 5xx retries exhausted', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/domains/check').times(4).reply(503);
    const client = createOpenproviderClient();
    await expect(
      client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
    ).rejects.toBeInstanceOf(OpenproviderUnavailableError);
  }, 15_000);

  it('respects Retry-After on 429 once', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(429, '', { 'retry-after': '0' });
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(200, {
        data: { results: [{ domain: 'a.com', status: 'free' }] },
      });
    const client = createOpenproviderClient();
    const r = await client.checkDomain('tok', {
      domains: [{ name: 'a', extension: 'com' }],
      with_price: false,
    });
    expect(r.results[0]?.domain).toBe('a.com');
  });

  it('throws OpenproviderClientError on 4xx (non-401/429)', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains/check')
      .reply(400, { error: 'bad input' });
    const client = createOpenproviderClient();
    await expect(
      client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
    ).rejects.toBeInstanceOf(OpenproviderClientError);
  });

  it('validates args via zod', async () => {
    const client = createOpenproviderClient();
    await expect(
      client.checkDomain('tok', { domains: [], with_price: false } as never),
    ).rejects.toThrow(/at least 1|too small|too_small/i);
  });
});

describe('openprovider client — read endpoints', () => {
  afterEach(() => nock.cleanAll());

  it('listDomains GETs /domains with query params and unwraps data', async () => {
    nock('https://api.openprovider.eu')
      .get('/v1beta/domains')
      .query({ limit: '100', offset: '0' })
      .reply(200, { data: { results: [{ id: 1, domain: 'a.com' }] } });
    const client = createOpenproviderClient();
    const r = (await client.listDomains('tok', { limit: 100, offset: 0 })) as {
      results: unknown[];
    };
    expect(r.results).toHaveLength(1);
  });

  it('getDomain GETs /domains/:id and unwraps data', async () => {
    nock('https://api.openprovider.eu')
      .get('/v1beta/domains/42')
      .reply(200, { data: { id: 42, domain: 'b.com' } });
    const client = createOpenproviderClient();
    const r = (await client.getDomain('tok', 42)) as { id: number };
    expect(r.id).toBe(42);
  });

  it('listContacts and getContact hit the contacts endpoints', async () => {
    nock('https://api.openprovider.eu')
      .get('/v1beta/contacts')
      .query({ limit: '50', offset: '0' })
      .reply(200, { data: { results: [] } });
    nock('https://api.openprovider.eu')
      .get('/v1beta/contacts/7')
      .reply(200, { data: { id: 7 } });
    const client = createOpenproviderClient();
    expect(
      (await client.listContacts('tok', { limit: 50, offset: 0 })) as { results: unknown[] },
    ).toBeTruthy();
    expect((await client.getContact('tok', 7)) as { id: number }).toMatchObject({ id: 7 });
  });

  it('getDomain maps 4xx to OpenproviderClientError', async () => {
    nock('https://api.openprovider.eu')
      .get('/v1beta/domains/999')
      .reply(404, { error: 'not found' });
    const client = createOpenproviderClient();
    await expect(client.getDomain('tok', 999)).rejects.toBeInstanceOf(OpenproviderClientError);
  });
});

describe('openprovider client — domain lifecycle methods', () => {
  const BASE = 'https://api.openprovider.eu';
  const PREFIX = '/v1beta';

  afterEach(() => nock.cleanAll());

  it('suggestDomain POSTs /domains/suggest-name and unwraps data', async () => {
    nock(BASE)
      .post(`${PREFIX}/domains/suggest-name`)
      .reply(200, { data: { results: [] } });
    const client = createOpenproviderClient();
    expect(await client.suggestDomain('tok', { name: 'example' })).toEqual({ results: [] });
  });

  it('getDomainAuthcode GETs /domains/:id/authcode and unwraps data', async () => {
    nock(BASE)
      .get(`${PREFIX}/domains/42/authcode`)
      .reply(200, { data: { auth_code: 'ZZ' } });
    const client = createOpenproviderClient();
    expect(await client.getDomainAuthcode('tok', 42)).toEqual({ auth_code: 'ZZ' });
  });

  it('resetDomainAuthcode POSTs /domains/:id/authcode/reset and unwraps data', async () => {
    nock(BASE)
      .post(`${PREFIX}/domains/42/authcode/reset`, (b: Record<string, unknown>) => b['id'] === 42)
      .reply(200, { data: { auth_code: 'NEW' } });
    const client = createOpenproviderClient();
    expect(await client.resetDomainAuthcode('tok', { id: 42 })).toEqual({ auth_code: 'NEW' });
  });

  it('approveDomainTransfer POSTs /domains/:id/transfer/approve and unwraps data', async () => {
    nock(BASE)
      .post(`${PREFIX}/domains/42/transfer/approve`, (b: Record<string, unknown>) => b['id'] === 42)
      .reply(200, { data: { success: true } });
    const client = createOpenproviderClient();
    expect(await client.approveDomainTransfer('tok', { id: 42 })).toEqual({ success: true });
  });

  it('sendFoa1DomainTransfer POSTs /domains/:id/transfer/send-foa1 and unwraps data', async () => {
    nock(BASE)
      .post(`${PREFIX}/domains/42/transfer/send-foa1`)
      .reply(200, { data: { success: true } });
    const client = createOpenproviderClient();
    expect(await client.sendFoa1DomainTransfer('tok', 42)).toEqual({ success: true });
  });

  it('deleteDomain DELETEs /domains/:id and unwraps data', async () => {
    nock(BASE)
      .delete(`${PREFIX}/domains/42`)
      .reply(200, { data: { success: true } });
    const client = createOpenproviderClient();
    expect(await client.deleteDomain('tok', 42)).toEqual({ success: true });
  });

  it('restartDomainOperation POSTs /domains/:id/last-operation/restart and unwraps data', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/domains/42/last-operation/restart`,
        (b: Record<string, unknown>) => b['id'] === 42,
      )
      .reply(200, { data: { success: true } });
    const client = createOpenproviderClient();
    expect(await client.restartDomainOperation('tok', { id: 42 })).toEqual({ success: true });
  });

  it('renewDomain POSTs /domains/:id/renew and unwraps data', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/domains/42/renew`,
        (b: Record<string, unknown>) => b['id'] === 42 && b['period'] === 1,
      )
      .reply(200, { data: { id: 42 } });
    const client = createOpenproviderClient();
    expect(await client.renewDomain('tok', { id: 42, period: 1 })).toEqual({ id: 42 });
  });

  it('transferDomain POSTs /domains/transfer and unwraps data', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/domains/transfer`,
        (b: Record<string, unknown>) =>
          (b['domain'] as Record<string, unknown>)['name'] === 'example' &&
          b['auth_code'] === 'ABC',
      )
      .reply(200, { data: { id: 99 } });
    const client = createOpenproviderClient();
    expect(
      await client.transferDomain('tok', {
        domain: { name: 'example', extension: 'com' },
        auth_code: 'ABC',
        owner_handle: 'H1',
      }),
    ).toEqual({ id: 99 });
  });

  it('tradeDomain POSTs /domains/trade and unwraps data', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/domains/trade`,
        (b: Record<string, unknown>) =>
          (b['domain'] as Record<string, unknown>)['name'] === 'example' &&
          b['auth_code'] === 'XYZ',
      )
      .reply(200, { data: { id: 55 } });
    const client = createOpenproviderClient();
    expect(
      await client.tradeDomain('tok', {
        domain: { name: 'example', extension: 'com' },
        auth_code: 'XYZ',
        owner_handle: 'H2',
      }),
    ).toEqual({ id: 55 });
  });

  it('restoreDomain POSTs /domains/:id/restore and unwraps data', async () => {
    nock(BASE)
      .post(`${PREFIX}/domains/42/restore`, (b: Record<string, unknown>) => b['id'] === 42)
      .reply(200, { data: { id: 42 } });
    const client = createOpenproviderClient();
    expect(await client.restoreDomain('tok', { id: 42 })).toEqual({ id: 42 });
  });
});

describe('openprovider client — DNS methods', () => {
  const BASE = 'https://api.openprovider.eu';
  const PREFIX = '/v1beta';

  afterEach(() => nock.cleanAll());

  // --- reads ---

  it('listDnsZones GETs /dns/zones', async () => {
    nock(BASE).get(`${PREFIX}/dns/zones`).reply(200, { data: [] });
    expect(await createOpenproviderClient().listDnsZones('tok')).toEqual([]);
  });

  it('getDnsZone GETs /dns/zones/:name (encoded)', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/zones/example.com`)
      .reply(200, { data: { name: 'example.com' } });
    expect(await createOpenproviderClient().getDnsZone('tok', 'example.com')).toEqual({
      name: 'example.com',
    });
  });

  it('listDnsZoneRecords GETs /dns/zones/:name/records', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/zones/example.com/records`)
      .reply(200, { data: { results: [] } });
    expect(await createOpenproviderClient().listDnsZoneRecords('tok', 'example.com')).toEqual({
      results: [],
    });
  });

  it('listNameservers GETs /dns/nameservers', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/nameservers`)
      .reply(200, { data: { results: [] } });
    expect(await createOpenproviderClient().listNameservers('tok')).toEqual({ results: [] });
  });

  it('getNameserver GETs /dns/nameservers/:name (encoded)', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/nameservers/ns1.example.com`)
      .reply(200, { data: { name: 'ns1.example.com' } });
    expect(await createOpenproviderClient().getNameserver('tok', 'ns1.example.com')).toEqual({
      name: 'ns1.example.com',
    });
  });

  it('listNsGroups GETs /dns/nameservers/groups', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/nameservers/groups`)
      .reply(200, { data: { results: [] } });
    expect(await createOpenproviderClient().listNsGroups('tok')).toEqual({ results: [] });
  });

  it('getNsGroup GETs /dns/nameservers/groups/:nsGroup (encoded)', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/nameservers/groups/my-group`)
      .reply(200, { data: { ns_group: 'my-group' } });
    expect(await createOpenproviderClient().getNsGroup('tok', 'my-group')).toEqual({
      ns_group: 'my-group',
    });
  });

  it('listDnsTemplates GETs /dns/templates', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/templates`)
      .reply(200, { data: { results: [] } });
    expect(await createOpenproviderClient().listDnsTemplates('tok')).toEqual({ results: [] });
  });

  it('getDnsTemplate GETs /dns/templates/:id', async () => {
    nock(BASE)
      .get(`${PREFIX}/dns/templates/7`)
      .reply(200, { data: { id: 7 } });
    expect(await createOpenproviderClient().getDnsTemplate('tok', 7)).toEqual({ id: 7 });
  });

  // --- writes ---

  it('createDnsZone POSTs /dns/zones with flat records', async () => {
    nock(BASE)
      .post(`${PREFIX}/dns/zones`, (b: Record<string, unknown>) => Array.isArray(b['records']))
      .reply(200, { data: { id: 1 } });
    expect(
      await createOpenproviderClient().createDnsZone('tok', {
        domain: { name: 'x', extension: 'com' },
        provider: 'openprovider',
        type: 'master',
        records: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }],
      }),
    ).toEqual({ id: 1 });
  });

  it('updateDnsZone PUTs /dns/zones/:name derived from domain', async () => {
    nock(BASE)
      .put(
        `${PREFIX}/dns/zones/x.com`,
        (b: Record<string, unknown>) =>
          typeof b['records'] === 'object' && !Array.isArray(b['records']),
      )
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().updateDnsZone('tok', {
        domain: { name: 'x', extension: 'com' },
        records: { add: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] },
      }),
    ).toEqual({ ok: true });
  });

  it('createNameserver POSTs /dns/nameservers with name+ip in body', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/dns/nameservers`,
        (b: Record<string, unknown>) =>
          typeof b['name'] === 'string' && typeof b['ip'] === 'string',
      )
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().createNameserver('tok', {
        name: 'ns1.x.com',
        ip: '1.2.3.4',
      }),
    ).toEqual({ ok: true });
  });

  it('updateNameserver PUTs /dns/nameservers/:name with ip in body', async () => {
    nock(BASE)
      .put(
        `${PREFIX}/dns/nameservers/ns1.x.com`,
        (b: Record<string, unknown>) => typeof b['ip'] === 'string',
      )
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().updateNameserver('tok', {
        name: 'ns1.x.com',
        ip: '5.6.7.8',
      }),
    ).toEqual({ ok: true });
  });

  it('createNsGroup POSTs /dns/nameservers/groups', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/dns/nameservers/groups`,
        (b: Record<string, unknown>) => typeof b['ns_group'] === 'string',
      )
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().createNsGroup('tok', {
        ns_group: 'G',
        name_servers: [{ name: 'ns1.x.com', ip: '1.2.3.4', seq_nr: 0 }],
      }),
    ).toEqual({ ok: true });
  });

  it('updateNsGroup PUTs /dns/nameservers/groups/:nsGroup with name_servers in body', async () => {
    nock(BASE)
      .put(`${PREFIX}/dns/nameservers/groups/G`, (b: Record<string, unknown>) =>
        Array.isArray(b['name_servers']),
      )
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().updateNsGroup('tok', {
        ns_group: 'G',
        name_servers: [{ name: 'ns1.x.com', ip: '1.2.3.4', seq_nr: 0 }],
      }),
    ).toEqual({ ok: true });
  });

  it('createDnsTemplate POSTs /dns/templates with name in body', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/dns/templates`,
        (b: Record<string, unknown>) => typeof b['name'] === 'string',
      )
      .reply(200, { data: { id: 5 } });
    expect(
      await createOpenproviderClient().createDnsTemplate('tok', { name: 'my-template' }),
    ).toEqual({ id: 5 });
  });

  it('createDomainToken POSTs /dns/domain-token', async () => {
    nock(BASE)
      .post(`${PREFIX}/dns/domain-token`, (b: Record<string, unknown>) => b['domain'] === 'x.com')
      .reply(200, { data: { token: 't' } });
    expect(
      await createOpenproviderClient().createDomainToken('tok', {
        domain: 'x.com',
        zone_provider: 'openprovider',
      }),
    ).toEqual({ token: 't' });
  });

  // --- deletes ---

  it('deleteDnsZone DELETEs /dns/zones/:name', async () => {
    nock(BASE)
      .delete(`${PREFIX}/dns/zones/x.com`)
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().deleteDnsZone('tok', 'x.com')).toEqual({ ok: true });
  });

  it('deleteNameserver DELETEs /dns/nameservers/:name', async () => {
    nock(BASE)
      .delete(`${PREFIX}/dns/nameservers/ns1.x.com`)
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().deleteNameserver('tok', 'ns1.x.com')).toEqual({
      ok: true,
    });
  });

  it('deleteNsGroup DELETEs /dns/nameservers/groups/:nsGroup', async () => {
    nock(BASE)
      .delete(`${PREFIX}/dns/nameservers/groups/G`)
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().deleteNsGroup('tok', 'G')).toEqual({ ok: true });
  });

  it('deleteDnsTemplate DELETEs /dns/templates/:id', async () => {
    nock(BASE)
      .delete(`${PREFIX}/dns/templates/7`)
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().deleteDnsTemplate('tok', 7)).toEqual({ ok: true });
  });
});

describe('openprovider client — SSL methods', () => {
  const BASE = 'https://api.openprovider.eu';
  const PREFIX = '/v1beta';

  afterEach(() => nock.cleanAll());

  // --- reads ---

  it('listSslProducts GETs /ssl/products', async () => {
    nock(BASE).get(`${PREFIX}/ssl/products`).reply(200, { data: [] });
    expect(await createOpenproviderClient().listSslProducts('tok')).toEqual([]);
  });

  it('getSslProduct GETs /ssl/products/:id', async () => {
    nock(BASE)
      .get(`${PREFIX}/ssl/products/123`)
      .reply(200, { data: { id: 123 } });
    expect(await createOpenproviderClient().getSslProduct('tok', 123)).toEqual({ id: 123 });
  });

  it('listSslOrders GETs /ssl/orders', async () => {
    nock(BASE)
      .get(`${PREFIX}/ssl/orders`)
      .reply(200, { data: { results: [] } });
    expect(await createOpenproviderClient().listSslOrders('tok')).toEqual({ results: [] });
  });

  it('getSslOrder GETs /ssl/orders/:id', async () => {
    nock(BASE)
      .get(`${PREFIX}/ssl/orders/42`)
      .reply(200, { data: { id: 42 } });
    expect(await createOpenproviderClient().getSslOrder('tok', 42)).toEqual({ id: 42 });
  });

  it('getSslApproverEmails GETs /ssl/approver-emails with domain query', async () => {
    nock(BASE)
      .get(`${PREFIX}/ssl/approver-emails`)
      .query({ domain: 'x.com' })
      .reply(200, { data: [] });
    expect(
      await createOpenproviderClient().getSslApproverEmails('tok', { domain: 'x.com' }),
    ).toEqual([]);
  });

  // --- writes ---

  it('createSslOrder POSTs /ssl/orders with the full order body', async () => {
    const body = {
      approver_email: 'a@b.c',
      autorenew: 'on' as const,
      csr: 'PEM',
      domain_amount: 1,
      domain_validation_methods: [{ host_name: 'x.com', method: 'dns' as const }],
      enable_dns_automation: false,
      host_names: ['x.com'],
      organization_handle: 'OH',
      period: 1,
      product_id: 1,
      signature_hash_algorithm: 'sha2',
      software_id: 'linux',
      start_provision: true,
      technical_handle: 'TH',
      wildcard_domain_amount: 0,
    };
    nock(BASE)
      .post(
        `${PREFIX}/ssl/orders`,
        (b: Record<string, unknown>) => b['product_id'] === 1 && Array.isArray(b['host_names']),
      )
      .reply(200, { data: { id: 5 } });
    expect(await createOpenproviderClient().createSslOrder('tok', body)).toEqual({ id: 5 });
  });

  it('renewSslOrder POSTs /ssl/orders/:id/renew with id derived from args', async () => {
    nock(BASE)
      .post(`${PREFIX}/ssl/orders/7/renew`, (b: Record<string, unknown>) => b['id'] === 7)
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().renewSslOrder('tok', {
        id: 7,
        enable_dns_automation: false,
      }),
    ).toEqual({ ok: true });
  });

  it('cancelSslOrder POSTs /ssl/orders/:id/cancel', async () => {
    nock(BASE)
      .post(`${PREFIX}/ssl/orders/9/cancel`, (b: Record<string, unknown>) => b['id'] === 9)
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().cancelSslOrder('tok', { id: 9 })).toEqual({ ok: true });
  });

  it('updateSslOrder PUTs /ssl/orders/:id with body', async () => {
    const body = {
      id: 3,
      approver_email: 'a@b.c',
      autorenew: 'off' as const,
      csr: 'PEM',
      domain_amount: 1,
      domain_validation_methods: [{ host_name: 'x.com', method: 'dns' as const }],
      enable_dns_automation: false,
      host_names: ['x.com'],
      organization_handle: 'OH',
      period: 1,
      product_id: 1,
      signature_hash_algorithm: 'sha2',
      software_id: 'linux',
      start_provision: true,
      technical_handle: 'TH',
      wildcard_domain_amount: 0,
    };
    nock(BASE)
      .put(`${PREFIX}/ssl/orders/3`)
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().updateSslOrder('tok', body)).toEqual({ ok: true });
  });

  it('updateSslApproverEmail PUTs /ssl/orders/:id/approver-email', async () => {
    nock(BASE)
      .put(
        `${PREFIX}/ssl/orders/5/approver-email`,
        (b: Record<string, unknown>) => b['approver_email'] === 'a@b.c',
      )
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().updateSslApproverEmail('tok', {
        id: 5,
        approver_email: 'a@b.c',
      }),
    ).toEqual({ ok: true });
  });

  it('resendSslApproverEmail POSTs /ssl/orders/:id/approver-email/resend', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/ssl/orders/6/approver-email/resend`,
        (b: Record<string, unknown>) => b['id'] === 6,
      )
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().resendSslApproverEmail('tok', { id: 6 })).toEqual({
      ok: true,
    });
  });

  it('createCsr POSTs /ssl/csr', async () => {
    nock(BASE)
      .post(`${PREFIX}/ssl/csr`, (b: Record<string, unknown>) => b['common_name'] === 'x.com')
      .reply(200, { data: { csr: 'PEM' } });
    expect(
      await createOpenproviderClient().createCsr('tok', {
        bits: 2048,
        common_name: 'x.com',
        country: 'NL',
        email: 'a@b.c',
        locality: 'Amsterdam',
        organization: 'X',
        signature_hash_algorithm: 'sha2',
        state: 'NH',
      }),
    ).toEqual({ csr: 'PEM' });
  });

  it('decodeCsr POSTs /ssl/csr/decode', async () => {
    nock(BASE)
      .post(`${PREFIX}/ssl/csr/decode`, (b: Record<string, unknown>) => b['csr'] === 'PEM')
      .reply(200, { data: { common_name: 'x.com' } });
    expect(await createOpenproviderClient().decodeCsr('tok', { csr: 'PEM' })).toEqual({
      common_name: 'x.com',
    });
  });

  it('createSslOtpToken POSTs /ssl/orders/:id/otp-tokens', async () => {
    nock(BASE)
      .post(`${PREFIX}/ssl/orders/4/otp-tokens`, (b: Record<string, unknown>) => b['id'] === 4)
      .reply(200, { data: { token: 't' } });
    expect(await createOpenproviderClient().createSslOtpToken('tok', { id: 4 })).toEqual({
      token: 't',
    });
  });

  it('reissueSslOrder POSTs /ssl/orders/:id/reissue with full body', async () => {
    const body = {
      id: 8,
      approver_email: 'a@b.c',
      autorenew: 'on' as const,
      csr: 'PEM',
      domain_amount: 1,
      domain_validation_methods: [{ host_name: 'x.com', method: 'dns' as const }],
      enable_dns_automation: false,
      host_names: ['x.com'],
      organization_handle: 'OH',
      period: 1,
      product_id: 1,
      signature_hash_algorithm: 'sha2',
      software_id: 'linux',
      start_provision: true,
      technical_handle: 'TH',
      wildcard_domain_amount: 0,
    };
    nock(BASE)
      .post(
        `${PREFIX}/ssl/orders/8/reissue`,
        (b: Record<string, unknown>) => b['id'] === 8 && b['product_id'] === 1,
      )
      .reply(200, { data: { ok: true } });
    expect(await createOpenproviderClient().reissueSslOrder('tok', body)).toEqual({ ok: true });
  });
});

describe('openprovider client — catalog + tag methods', () => {
  const BASE = 'https://api.openprovider.eu';
  const PREFIX = '/v1beta';

  afterEach(() => nock.cleanAll());

  it('listTlds GETs /tlds', async () => {
    nock(BASE).get(`${PREFIX}/tlds`).reply(200, { data: [] });
    expect(await createOpenproviderClient().listTlds('tok')).toEqual([]);
  });

  it('getTld GETs /tlds/:name (encoded)', async () => {
    nock(BASE)
      .get(`${PREFIX}/tlds/co.uk`)
      .reply(200, { data: { name: 'co.uk' } });
    expect(await createOpenproviderClient().getTld('tok', 'co.uk')).toEqual({ name: 'co.uk' });
  });

  it('getDomainPrice GETs /domains/prices with dot-notation query', async () => {
    nock(BASE)
      .get(`${PREFIX}/domains/prices`)
      .query({ 'domain.name': 'x', 'domain.extension': 'com', operation: 'create' })
      .reply(200, { data: { price: { product: { price: 9.99 } } } });
    expect(
      await createOpenproviderClient().getDomainPrice('tok', {
        domain: { name: 'x', extension: 'com' },
        operation: 'create',
      }),
    ).toEqual({ price: { product: { price: 9.99 } } });
  });

  it('getDomainPrice includes idn_script when provided', async () => {
    nock(BASE)
      .get(`${PREFIX}/domains/prices`)
      .query({
        'domain.name': 'x',
        'domain.extension': 'com',
        operation: 'create',
        'additional_data.idn_script': 'cyrl',
      })
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().getDomainPrice('tok', {
        domain: { name: 'x', extension: 'com' },
        operation: 'create',
        additional_data: { idn_script: 'cyrl' },
      }),
    ).toEqual({ ok: true });
  });

  it('listTags GETs /tags', async () => {
    nock(BASE).get(`${PREFIX}/tags`).reply(200, { data: [] });
    expect(await createOpenproviderClient().listTags('tok')).toEqual([]);
  });

  it('createTag POSTs /tags with {key,value}', async () => {
    nock(BASE)
      .post(
        `${PREFIX}/tags`,
        (b: Record<string, unknown>) => b['key'] === 'customer' && b['value'] === 'Tech',
      )
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().createTag('tok', { key: 'customer', value: 'Tech' }),
    ).toEqual({ ok: true });
  });

  it('deleteTag DELETEs /tags?key=...&value=...', async () => {
    nock(BASE)
      .delete(`${PREFIX}/tags`)
      .query({ key: 'customer', value: 'Tech' })
      .reply(200, { data: { ok: true } });
    expect(
      await createOpenproviderClient().deleteTag('tok', { key: 'customer', value: 'Tech' }),
    ).toEqual({ ok: true });
  });
});

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

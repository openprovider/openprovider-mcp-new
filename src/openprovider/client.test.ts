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

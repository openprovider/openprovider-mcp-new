import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { createOpenproviderClient } from './client.js';
import { OpenproviderAuthError, OpenproviderClientError } from './errors.js';

describe('openprovider client — write methods', () => {
  afterEach(() => nock.cleanAll());

  it('registerDomain POSTs /domains and unwraps data', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains')
      .reply(200, { data: { id: 99, status: 'ACT' } });
    const client = createOpenproviderClient();
    const r = (await client.registerDomain('tok', {
      domain: { name: 'a', extension: 'com' },
      period: 1,
      owner_handle: 'AB',
    })) as { id: number };
    expect(r.id).toBe(99);
  });

  it('registerDomain sends X-Idempotency-Key when provided', async () => {
    let seen: string | undefined;
    nock('https://api.openprovider.eu')
      .post('/v1beta/domains')
      .reply(function () {
        seen = this.req.headers['x-idempotency-key'] as string;
        return [200, { data: { id: 1 } }];
      });
    const client = createOpenproviderClient();
    await client.registerDomain(
      'tok',
      { domain: { name: 'a', extension: 'com' }, period: 1, owner_handle: 'AB' },
      'idem-123',
    );
    expect(seen).toBe('idem-123');
  });

  it('createContact POSTs /contacts', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/contacts')
      .reply(200, { data: { handle: 'XY123' } });
    const client = createOpenproviderClient();
    const r = (await client.createContact('tok', {
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
    })) as { handle: string };
    expect(r.handle).toBe('XY123');
  });

  it('updateContact PUTs /contacts/:id', async () => {
    nock('https://api.openprovider.eu')
      .put('/v1beta/contacts/7')
      .reply(200, { data: { handle: 'XY123' } });
    const client = createOpenproviderClient();
    await client.updateContact('tok', 7, { id: 7, email: 'a@b.co' });
  });

  it('deleteContact DELETEs /contacts/:id', async () => {
    nock('https://api.openprovider.eu')
      .delete('/v1beta/contacts/7')
      .reply(200, { data: { success: true } });
    const client = createOpenproviderClient();
    await client.deleteContact('tok', 7);
  });

  it('updateDomain PUTs /domains/:id', async () => {
    nock('https://api.openprovider.eu')
      .put('/v1beta/domains/42')
      .reply(200, { data: { id: 42 } });
    const client = createOpenproviderClient();
    await client.updateDomain('tok', 42, { id: 42, autorenew: 'on' });
  });

  it('maps a 401 on a write to OpenproviderAuthError', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/domains').reply(401, {});
    const client = createOpenproviderClient();
    await expect(
      client.registerDomain('tok', {
        domain: { name: 'a', extension: 'com' },
        period: 1,
        owner_handle: 'AB',
      }),
    ).rejects.toBeInstanceOf(OpenproviderAuthError);
  });

  it('maps a 4xx on a write to OpenproviderClientError', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/contacts').reply(400, { desc: 'bad' });
    const client = createOpenproviderClient();
    await expect(
      client.createContact('tok', {
        name: { first_name: 'A', last_name: 'B' },
        phone: { country_code: '+1', subscriber_number: '5551234' },
        address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
      }),
    ).rejects.toBeInstanceOf(OpenproviderClientError);
  });
});

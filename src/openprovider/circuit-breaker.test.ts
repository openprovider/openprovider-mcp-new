import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { createOpenproviderClient } from './client.js';
import { OpenproviderUnavailableError } from './errors.js';

describe('openprovider client — circuit breaker', () => {
  afterEach(() => nock.cleanAll());

  it('opens the circuit after sustained failures and fast-fails subsequent calls', async () => {
    // Each call retries up to 3 times on 503, so 20 calls = up to 80 interceptors.
    nock('https://api.openprovider.eu').post('/v1beta/domains/check').times(80).reply(503);
    const client = createOpenproviderClient({
      breakerOptions: { volumeThreshold: 5, errorThresholdPercentage: 50, resetTimeout: 30_000 },
    });
    // First 5 calls drain volume + trip the breaker open.
    for (let i = 0; i < 5; i++) {
      await expect(
        client.checkDomain('tok', {
          domains: [{ name: 'x', extension: 'com' }],
          with_price: false,
        }),
      ).rejects.toBeInstanceOf(OpenproviderUnavailableError);
    }
    // The next call should fast-fail via the breaker; no new HTTP traffic.
    const pendingBefore = nock.pendingMocks().length;
    await expect(
      client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
    ).rejects.toBeInstanceOf(OpenproviderUnavailableError);
    const pendingAfter = nock.pendingMocks().length;
    expect(pendingAfter).toBe(pendingBefore); // No additional interceptor consumed.
  }, 60_000);
});

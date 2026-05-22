import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { createOpenproviderTokenManager } from './token-manager.js';

function makeMemoryCache() {
  const m = new Map<string, { token: string; expiresAt: Date }>();
  return {
    get: (t: string) => Promise.resolve(m.get(t) ?? null),
    set: (t: string, v: { token: string; expiresAt: Date }) => {
      m.set(t, v);
    },
    clear: (t: string) => {
      m.delete(t);
    },
  };
}

describe('openprovider token manager', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('logs in on first call and caches the token', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .reply(200, { data: { token: 'jwt-1', reseller_id: 42 } });

    const mgr = createOpenproviderTokenManager({
      fetchCredentials: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
      cache: makeMemoryCache(),
    });

    expect(await mgr.getToken('tenant-a')).toBe('jwt-1');
    // Second call hits in-memory cache, no upstream traffic.
    expect(await mgr.getToken('tenant-a')).toBe('jwt-1');
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('singleflights concurrent refreshes', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .reply(200, { data: { token: 'jwt-2', reseller_id: 42 } });

    const mgr = createOpenproviderTokenManager({
      fetchCredentials: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
      cache: makeMemoryCache(),
    });

    const results = await Promise.all([
      mgr.getToken('tenant-x'),
      mgr.getToken('tenant-x'),
      mgr.getToken('tenant-x'),
    ]);
    expect(results).toEqual(['jwt-2', 'jwt-2', 'jwt-2']);
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('refreshes when the cached token is expired', async () => {
    nock('https://api.openprovider.eu')
      .post('/v1beta/auth/login')
      .reply(200, { data: { token: 'jwt-fresh', reseller_id: 42 } });

    const cache = makeMemoryCache();
    cache.set('tenant-z', { token: 'stale', expiresAt: new Date(Date.now() - 1000) });

    const mgr = createOpenproviderTokenManager({
      fetchCredentials: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
      cache,
    });

    expect(await mgr.getToken('tenant-z')).toBe('jwt-fresh');
  });

  it('throws OpenproviderAuthError on 401', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/auth/login').reply(401, { error: 'bad' });

    const mgr = createOpenproviderTokenManager({
      fetchCredentials: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
      cache: makeMemoryCache(),
    });

    await expect(mgr.getToken('tenant-bad')).rejects.toThrow(/invalid Openprovider credentials/);
  });
});

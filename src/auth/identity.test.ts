import { describe, expect, it } from 'vitest';
import { createIdentityResolver } from './identity.js';

describe('identity resolver', () => {
  const resolve = createIdentityResolver({
    devToken: 'dev-bearer',
    devPrincipal: {
      kind: 'user',
      tenantId: '00000000-0000-0000-0000-00000000aaaa',
      userId: '00000000-0000-0000-0000-00000000bbbb',
      subject: 'dev',
      scopes: ['mcp:read'],
      role: 'owner',
    },
  });

  it('resolves the dev principal for the dev bearer', async () => {
    const p = await resolve('Bearer dev-bearer');
    expect(p?.kind).toBe('user');
    if (p?.kind === 'user') {
      expect(p.tenantId).toBe('00000000-0000-0000-0000-00000000aaaa');
    }
  });

  it('returns null for unknown bearer', async () => {
    expect(await resolve('Bearer nope')).toBeNull();
  });

  it('returns null when header missing', async () => {
    expect(await resolve(undefined)).toBeNull();
  });

  it('returns null for non-bearer scheme', async () => {
    expect(await resolve('Basic xyz')).toBeNull();
  });

  it('returns null for op_live_ key when no apiKeyResolver configured', async () => {
    expect(await resolve('Bearer op_live_xxx')).toBeNull();
  });

  it('resolves an op_live_ key via the apiKeyResolver', async () => {
    const resolve2 = createIdentityResolver({
      devToken: 'dev',
      devPrincipal: {
        kind: 'user',
        tenantId: 't',
        userId: 'u',
        subject: 'dev',
        scopes: [],
        role: 'owner',
      },
      apiKeyResolver: (k) =>
        k === 'op_live_good'
          ? Promise.resolve({
              kind: 'service',
              tenantId: 'tnt',
              apiKeyId: 'ak',
              subject: 'apikey:ak',
              scopes: ['mcp:read'],
            })
          : Promise.resolve(null),
    });
    const p = await resolve2('Bearer op_live_good');
    expect(p?.kind).toBe('service');
  });

  it('returns null for an unknown op_live_ key', async () => {
    const resolve3 = createIdentityResolver({
      devToken: 'dev',
      devPrincipal: {
        kind: 'user',
        tenantId: 't',
        userId: 'u',
        subject: 'dev',
        scopes: [],
        role: 'owner',
      },
      apiKeyResolver: () => Promise.resolve(null),
    });
    expect(await resolve3('Bearer op_live_nope')).toBeNull();
  });

});

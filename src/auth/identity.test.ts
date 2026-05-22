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

  it('throws for API key path (not implemented in phase 1)', async () => {
    await expect(resolve('Bearer op_live_xxx')).rejects.toThrow(/api key.*phase/i);
  });

  it('resolves a real OAuth bearer to a user Principal', async () => {
    const fakeVerifier = (token: string) => {
      if (token !== 'oauth_real') return Promise.reject(new Error('nope'));
      return Promise.resolve({
        subject: 'user_42',
        scopes: ['mcp:read'],
        tenantId: 'tnt_xyz',
        expiresAt: new Date(Date.now() + 60_000),
      });
    };
    const resolve2 = createIdentityResolver({
      devToken: 'dev-bearer',
      devPrincipal: {
        kind: 'user',
        tenantId: 't',
        userId: 'u',
        subject: 'dev',
        scopes: [],
        role: 'owner',
      },
      verifier: fakeVerifier,
    });
    const p = await resolve2('Bearer oauth_real');
    expect(p?.kind).toBe('user');
    if (p?.kind === 'user') {
      expect(p.subject).toBe('user_42');
      expect(p.tenantId).toBe('tnt_xyz');
      expect(p.scopes).toEqual(['mcp:read']);
    }
  });

  it('returns null when verifier rejects', async () => {
    const fakeVerifier = () => Promise.reject(new Error('bad'));
    const resolve2 = createIdentityResolver({
      devToken: 'dev-bearer',
      devPrincipal: {
        kind: 'user',
        tenantId: 't',
        userId: 'u',
        subject: 'dev',
        scopes: [],
        role: 'owner',
      },
      verifier: fakeVerifier,
    });
    expect(await resolve2('Bearer some_bad_token')).toBeNull();
  });
});

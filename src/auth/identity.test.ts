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
});

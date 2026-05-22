import { describe, expect, it, vi } from 'vitest';
import { createCheckDomainTool } from './check-domain.js';
import type { Principal } from '../auth/principal.js';
import type { CheckDomainResult } from '../openprovider/types.js';

const principal: Principal = {
  kind: 'user',
  tenantId: 't1',
  userId: 'u1',
  subject: 's1',
  scopes: ['mcp:read'],
  role: 'operator',
};

describe('check_domain tool', () => {
  it('fetches token then calls client.checkDomain', async () => {
    const fakeResult: CheckDomainResult = { results: [{ domain: 'example.com', status: 'free' }] };
    const client = { checkDomain: vi.fn().mockResolvedValue(fakeResult) };
    const tokenManager = {
      getToken: vi.fn().mockResolvedValue('jwt'),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
    const tool = createCheckDomainTool({ client, tokenManager });

    const result = await tool.handler(
      { domains: [{ name: 'example', extension: 'com' }], with_price: true },
      principal,
    );

    expect(result).toEqual(fakeResult);
    expect(tokenManager.getToken).toHaveBeenCalledWith('t1');
    expect(client.checkDomain).toHaveBeenCalledWith(
      'jwt',
      expect.objectContaining({ domains: [{ name: 'example', extension: 'com' }] }),
    );
  });

  it('propagates client errors', async () => {
    const client = {
      checkDomain: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('boom'), { code: 'openprovider_unavailable' })),
    };
    const tokenManager = {
      getToken: vi.fn().mockResolvedValue('jwt'),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
    const tool = createCheckDomainTool({ client, tokenManager });

    await expect(
      tool.handler(
        { domains: [{ name: 'example', extension: 'com' }], with_price: false },
        principal,
      ),
    ).rejects.toMatchObject({ code: 'openprovider_unavailable' });
  });
});

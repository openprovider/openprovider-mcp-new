import { describe, expect, it } from 'vitest';
import { getTenantDek } from './dek.js';
import { createFakeKms } from './fake-kms.js';

function memRepo() {
  const keys = new Map<string, { wrappedDek: Buffer; kmsKeyArn: string }>();
  return {
    store: keys,
    getTenantKey: (t: string) => Promise.resolve(keys.get(t) ?? null),
    setTenantKey: (t: string, v: { wrappedDek: Buffer; kmsKeyArn: string }) => {
      keys.set(t, v);
      return Promise.resolve();
    },
  };
}

describe('getTenantDek', () => {
  it('creates a DEK on first call and reuses it after', async () => {
    const kms = createFakeKms();
    const repo = memRepo();
    const first = await getTenantDek({ kms, kmsKeyArn: 'arn', repo, tenantId: 't1' });
    expect(repo.store.has('t1')).toBe(true);
    const second = await getTenantDek({ kms, kmsKeyArn: 'arn', repo, tenantId: 't1' });
    // Same plaintext key both times (decrypt of the stored wrapped DEK).
    expect(second.equals(first)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createFakeKms } from './fake-kms.js';
import { createSecretsStore } from './store.js';

describe('secrets/store', () => {
  it('round-trips a plaintext through put → get', async () => {
    const store = createSecretsStore({
      kms: createFakeKms(),
      kmsKeyArn: 'arn:test',
      repo: createInMemoryRepo(),
    });
    const tenantId = 'tenant-a';

    await store.put(tenantId, 'openprovider.password', Buffer.from('hunter2'));
    const got = await store.get(tenantId, 'openprovider.password');

    expect(got?.toString()).toBe('hunter2');
  });

  it('returns null when the secret is missing', async () => {
    const store = createSecretsStore({
      kms: createFakeKms(),
      kmsKeyArn: 'arn:test',
      repo: createInMemoryRepo(),
    });
    expect(await store.get('tenant-a', 'missing')).toBeNull();
  });
});

function createInMemoryRepo() {
  const keys = new Map<string, { wrappedDek: Buffer; kmsKeyArn: string }>();
  const secrets = new Map<string, { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number }>();
  return {
    getTenantKey(t: string) { return Promise.resolve(keys.get(t) ?? null); },
    setTenantKey(t: string, v: { wrappedDek: Buffer; kmsKeyArn: string }) { keys.set(t, v); return Promise.resolve(); },
    getSecret(t: string, n: string) { return Promise.resolve(secrets.get(`${t}:${n}`) ?? null); },
    upsertSecret(
      t: string,
      n: string,
      v: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number },
    ) {
      secrets.set(`${t}:${n}`, v);
      return Promise.resolve();
    },
  };
}

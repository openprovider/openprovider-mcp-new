import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createGcpKms } from './gcp-kms.js';

// A fake @google-cloud/kms client: encrypt wraps with a fixed key, decrypt unwraps.
function fakeKmsClient() {
  const master = Buffer.alloc(32, 7);
  return {
    encrypt({ plaintext }: { name: string; plaintext: Buffer }): Promise<[{ ciphertext: Buffer }]> {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', master, iv);
      const enc = Buffer.concat([c.update(plaintext), c.final()]);
      const tag = c.getAuthTag();
      return Promise.resolve([{ ciphertext: Buffer.concat([iv, tag, enc]) }]);
    },
    decrypt({
      ciphertext,
    }: {
      name: string;
      ciphertext: Buffer;
    }): Promise<[{ plaintext: Buffer }]> {
      const iv = ciphertext.subarray(0, 12);
      const tag = ciphertext.subarray(12, 28);
      const enc = ciphertext.subarray(28);
      const d = createDecipheriv('aes-256-gcm', master, iv);
      d.setAuthTag(tag);
      return Promise.resolve([{ plaintext: Buffer.concat([d.update(enc), d.final()]) }]);
    },
  };
}

describe('gcp-kms adapter', () => {
  it('generateDataKey returns a 32-byte plaintext + wrapped ciphertext; decrypt round-trips', async () => {
    const kms = createGcpKms({
      keyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      client: fakeKmsClient() as never,
    });
    const { plaintext, ciphertext } = await kms.generateDataKey('ignored');
    expect(plaintext).toHaveLength(32);
    expect(ciphertext.length).toBeGreaterThan(32);
    const back = await kms.decrypt('ignored', ciphertext);
    expect(back.equals(plaintext)).toBe(true);
  });
});

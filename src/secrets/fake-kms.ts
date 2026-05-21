import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Kms } from './kms.js';

// A fixed 32-byte master key for deterministic tests.
// In production this lives in cloud KMS and is never on disk.
const MASTER = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

export function createFakeKms(): Kms {
  return {
    generateDataKey() {
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', MASTER, iv);
      const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Wire format: iv (12) || tag (16) || enc (32)
      const ciphertext = Buffer.concat([iv, tag, enc]);
      return Promise.resolve({ plaintext, ciphertext });
    },
    decrypt(_arn, ciphertext) {
      const iv = ciphertext.subarray(0, 12);
      const tag = ciphertext.subarray(12, 28);
      const enc = ciphertext.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', MASTER, iv);
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(enc), decipher.final()]));
    },
  };
}

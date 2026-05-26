import { describe, expect, it } from 'vitest';
import { createGcpKms } from '../../../src/secrets/gcp-kms.js';

const LIVE = process.env.GCP_LIVE === '1';
const d = LIVE ? describe : describe.skip;

// Requires: GCP_LIVE=1, GCP_KMS_KEY_NAME=projects/.../cryptoKeys/..., GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json
d('live GCP KMS — DEK wrap/unwrap round trip', () => {
  it('generateDataKey then decrypt returns the same key', async () => {
    const kms = createGcpKms({ keyName: process.env.GCP_KMS_KEY_NAME ?? '' });
    const { plaintext, ciphertext } = await kms.generateDataKey(process.env.GCP_KMS_KEY_NAME ?? '');
    const back = await kms.decrypt(process.env.GCP_KMS_KEY_NAME ?? '', ciphertext);
    expect(back.equals(plaintext)).toBe(true);
  }, 30_000);
});

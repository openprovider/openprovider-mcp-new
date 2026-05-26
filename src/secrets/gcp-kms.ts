import { KeyManagementServiceClient } from '@google-cloud/kms';
import { randomBytes } from 'node:crypto';
import type { Kms } from './kms.js';

interface KmsLike {
  encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext?: unknown }]>;
  decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext?: unknown }]>;
}

export function createGcpKms(opts: { keyName: string; client?: KmsLike }): Kms {
  const client: KmsLike = opts.client ?? (new KeyManagementServiceClient() as unknown as KmsLike);
  return {
    async generateDataKey(_keyArn: string) {
      const plaintext = randomBytes(32);
      const [resp] = await client.encrypt({ name: opts.keyName, plaintext });
      if (!resp.ciphertext) throw new Error('GCP KMS encrypt returned no ciphertext');
      return { plaintext, ciphertext: Buffer.from(resp.ciphertext as Uint8Array) };
    },
    async decrypt(_keyArn: string, ciphertext: Buffer) {
      const [resp] = await client.decrypt({ name: opts.keyName, ciphertext });
      if (!resp.plaintext) throw new Error('GCP KMS decrypt returned no plaintext');
      return Buffer.from(resp.plaintext as Uint8Array);
    },
  };
}

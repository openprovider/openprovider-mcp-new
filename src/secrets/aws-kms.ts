import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import type { Kms } from './kms.js';

export function createAwsKms(opts: { region: string; endpoint?: string }): Kms {
  const client = new KMSClient({
    region: opts.region,
    ...(opts.endpoint
      ? {
          endpoint: opts.endpoint,
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        }
      : {}),
  });
  return {
    async generateDataKey(keyArn) {
      const out = await client.send(
        new GenerateDataKeyCommand({ KeyId: keyArn, KeySpec: 'AES_256' }),
      );
      if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS returned no key');
      return {
        plaintext: Buffer.from(out.Plaintext),
        ciphertext: Buffer.from(out.CiphertextBlob),
      };
    },
    async decrypt(_arn, ciphertext) {
      const out = await client.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
      if (!out.Plaintext) throw new Error('KMS decrypt returned no plaintext');
      return Buffer.from(out.Plaintext);
    },
  };
}

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Kms } from './kms.js';
import { getTenantDek } from './dek.js';

export interface SecretsRepo {
  getTenantKey(tenantId: string): Promise<{ wrappedDek: Buffer; kmsKeyArn: string } | null>;
  setTenantKey(tenantId: string, value: { wrappedDek: Buffer; kmsKeyArn: string }): Promise<void>;
  getSecret(
    tenantId: string,
    name: string,
  ): Promise<{ ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number } | null>;
  upsertSecret(
    tenantId: string,
    name: string,
    value: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number },
  ): Promise<void>;
}

export interface SecretsStore {
  put(tenantId: string, name: string, plaintext: Buffer): Promise<void>;
  get(tenantId: string, name: string): Promise<Buffer | null>;
}

export function createSecretsStore(deps: {
  kms: Kms;
  kmsKeyArn: string;
  repo: SecretsRepo;
}): SecretsStore {
  const { kms, kmsKeyArn, repo } = deps;

  async function getOrCreateDek(tenantId: string): Promise<Buffer> {
    return getTenantDek({ kms, kmsKeyArn, repo, tenantId });
  }

  return {
    async put(tenantId, name, plaintext) {
      const dek = await getOrCreateDek(tenantId);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dek, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const prev = await repo.getSecret(tenantId, name);
      await repo.upsertSecret(tenantId, name, {
        ciphertext,
        nonce,
        authTag,
        version: (prev?.version ?? 0) + 1,
      });
      dek.fill(0);
    },
    async get(tenantId, name) {
      const row = await repo.getSecret(tenantId, name);
      if (!row) return null;
      const dek = await getOrCreateDek(tenantId);
      const decipher = createDecipheriv('aes-256-gcm', dek, row.nonce);
      decipher.setAuthTag(row.authTag);
      const out = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      dek.fill(0);
      return out;
    },
  };
}

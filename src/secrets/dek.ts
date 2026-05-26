import type { Kms } from './kms.js';

export interface DekRepo {
  getTenantKey(tenantId: string): Promise<{ wrappedDek: Buffer; kmsKeyArn: string } | null>;
  setTenantKey(tenantId: string, value: { wrappedDek: Buffer; kmsKeyArn: string }): Promise<void>;
}

/**
 * Single source of truth for retrieving (or lazily creating) a tenant's
 * data-encryption key. Used by secrets/store and by the openprovider token cache.
 */
export async function getTenantDek(deps: {
  kms: Kms;
  kmsKeyArn: string;
  repo: DekRepo;
  tenantId: string;
}): Promise<Buffer> {
  const existing = await deps.repo.getTenantKey(deps.tenantId);
  if (existing) return deps.kms.decrypt(existing.kmsKeyArn, existing.wrappedDek);
  const { plaintext, ciphertext } = await deps.kms.generateDataKey(deps.kmsKeyArn);
  await deps.repo.setTenantKey(deps.tenantId, {
    wrappedDek: ciphertext,
    kmsKeyArn: deps.kmsKeyArn,
  });
  return plaintext;
}

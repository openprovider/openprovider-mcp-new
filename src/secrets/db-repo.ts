import type pg from 'pg';
import type { SecretsRepo } from './store.js';

export function createDbSecretsRepo(client: pg.PoolClient): SecretsRepo {
  return {
    async getTenantKey(tenantId) {
      const r = await client.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
        'SELECT wrapped_dek, kms_key_arn FROM tenant_keys WHERE tenant_id = $1',
        [tenantId],
      );
      return r.rows[0]
        ? { wrappedDek: r.rows[0].wrapped_dek, kmsKeyArn: r.rows[0].kms_key_arn }
        : null;
    },
    async setTenantKey(tenantId, v) {
      await client.query(
        `INSERT INTO tenant_keys (tenant_id, wrapped_dek, kms_key_arn)
         VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE
           SET wrapped_dek = EXCLUDED.wrapped_dek,
               kms_key_arn = EXCLUDED.kms_key_arn,
               rotated_at = now()`,
        [tenantId, v.wrappedDek, v.kmsKeyArn],
      );
    },
    async getSecret(tenantId, name) {
      const r = await client.query<{
        ciphertext: Buffer;
        nonce: Buffer;
        auth_tag: Buffer;
        version: number;
      }>(
        'SELECT ciphertext, nonce, auth_tag, version FROM tenant_secrets WHERE tenant_id = $1 AND name = $2',
        [tenantId, name],
      );
      const row = r.rows[0];
      return row
        ? { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, version: row.version }
        : null;
    },
    async upsertSecret(tenantId, name, v) {
      await client.query(
        `INSERT INTO tenant_secrets (tenant_id, name, ciphertext, nonce, auth_tag, version)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, name) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext,
               nonce = EXCLUDED.nonce,
               auth_tag = EXCLUDED.auth_tag,
               version = EXCLUDED.version,
               rotated_at = now()`,
        [tenantId, name, v.ciphertext, v.nonce, v.authTag, v.version],
      );
    },
  };
}

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type pg from 'pg';
import type { TokenCache } from './token-manager.js';

export interface PgTokenCacheDeps {
  client: pg.PoolClient;
  getDek: (tenantId: string) => Promise<Buffer>;
}

export function createPgTokenCache(deps: PgTokenCacheDeps): TokenCache {
  return {
    async get(tenantId) {
      const r = await deps.client.query<{
        cached_token: Buffer | null;
        cached_token_nonce: Buffer | null;
        cached_token_tag: Buffer | null;
        token_expires_at: Date | null;
      }>(
        'SELECT cached_token, cached_token_nonce, cached_token_tag, token_expires_at FROM openprovider_accounts WHERE tenant_id = $1',
        [tenantId],
      );
      const row = r.rows[0];
      if (
        !row?.cached_token ||
        !row.cached_token_nonce ||
        !row.cached_token_tag ||
        !row.token_expires_at
      ) {
        return null;
      }
      const dek = await deps.getDek(tenantId);
      const decipher = createDecipheriv('aes-256-gcm', dek, row.cached_token_nonce);
      decipher.setAuthTag(row.cached_token_tag);
      const tokenBuf = Buffer.concat([decipher.update(row.cached_token), decipher.final()]);
      dek.fill(0);
      return { token: tokenBuf.toString('utf8'), expiresAt: row.token_expires_at };
    },
    async set(tenantId, v) {
      const dek = await deps.getDek(tenantId);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dek, nonce);
      const ciphertext = Buffer.concat([cipher.update(v.token, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      dek.fill(0);
      await deps.client.query(
        `UPDATE openprovider_accounts
            SET cached_token = $2,
                cached_token_nonce = $3,
                cached_token_tag = $4,
                token_expires_at = $5,
                last_verified_at = now()
          WHERE tenant_id = $1`,
        [tenantId, ciphertext, nonce, tag, v.expiresAt],
      );
    },
    async clear(tenantId) {
      await deps.client.query(
        `UPDATE openprovider_accounts
            SET cached_token = NULL,
                cached_token_nonce = NULL,
                cached_token_tag = NULL,
                token_expires_at = NULL
          WHERE tenant_id = $1`,
        [tenantId],
      );
    },
  };
}

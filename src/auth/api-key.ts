import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from './principal.js';

const PREFIX_LEN = 12; // 'op_live_' (8) + 4 chars of the random part

export function generateApiKey(): { key: string; prefix: string } {
  const rand = randomBytes(32).toString('base64url');
  const key = `op_live_${rand}`;
  return { key, prefix: key.slice(0, PREFIX_LEN) };
}

export function prefixOf(key: string): string {
  return key.slice(0, PREFIX_LEN);
}

export function hashApiKey(key: string): Promise<string> {
  return argon2.hash(key, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
}

export function verifyApiKey(hash: string, key: string): Promise<boolean> {
  return argon2.verify(hash, key).catch(() => false);
}

export interface IssuedKey {
  id: string;
  key: string;
  prefix: string;
}

/** Issues a key under the caller's already-set tenant context (RLS). Returns the plaintext ONCE. */
export async function issueApiKey(
  client: pg.PoolClient,
  input: { tenantId: string; name: string; scopes: string[]; createdByUserId?: string },
): Promise<IssuedKey> {
  const { key, prefix } = generateApiKey();
  const hash = await hashApiKey(key);
  const r = await client.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, prefix, hash, name, scopes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.tenantId, prefix, hash, input.name, input.scopes, input.createdByUserId ?? null],
  );
  return { id: r.rows[0]!.id, key, prefix };
}

export type ApiKeyResolver = (presentedKey: string) => Promise<Principal | null>;

export function createApiKeyResolver(pool: pg.Pool): ApiKeyResolver {
  return async (presentedKey) => {
    if (!presentedKey.startsWith('op_live_')) return null;
    const prefix = prefixOf(presentedKey);
    const client = await pool.connect();
    try {
      await client.query('SET ROLE app_role');
      const candidates = await client.query<{
        id: string;
        tenant_id: string;
        hash: string;
        scopes: string[];
        expires_at: Date | null;
        revoked_at: Date | null;
      }>('SELECT * FROM resolve_api_key($1)', [prefix]);
      for (const c of candidates.rows) {
        if (!(await verifyApiKey(c.hash, presentedKey))) continue;
        if (c.revoked_at) return null;
        if (c.expires_at && c.expires_at.getTime() < Date.now()) return null;
        // best-effort last_used_at under the key's tenant context
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE app_role');
          await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', c.tenant_id]);
          await client.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [c.id]);
          await client.query('COMMIT');
        } catch {
          await client.query('ROLLBACK').catch(() => {});
        }
        return {
          kind: 'service',
          tenantId: c.tenant_id,
          apiKeyId: c.id,
          subject: `apikey:${c.id}`,
          scopes: c.scopes,
        };
      }
      return null;
    } finally {
      client.release();
    }
  };
}

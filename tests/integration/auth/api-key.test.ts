import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { issueApiKey, createApiKeyResolver } from '../../../src/auth/api-key.js';

const T = '00000000-0000-0000-0000-00000000aa02';

describe('api-key resolver (integration)', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let issued: { id: string; key: string };

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;

    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]);
    } finally {
      c.release();
    }

    await runAsTenant(pool, T, async (c) => {
      issued = await issueApiKey(c, { tenantId: T, name: 'k', scopes: ['mcp:read', 'mcp:write'] });
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('authenticates a valid key → service Principal', async () => {
    const resolve = createApiKeyResolver(pool);
    const p = await resolve(issued.key);
    expect(p?.kind).toBe('service');
    if (p?.kind === 'service') {
      expect(p.tenantId).toBe(T);
      expect(p.scopes).toContain('mcp:write');
    }
  });

  it('rejects a wrong key', async () => {
    expect(await createApiKeyResolver(pool)(issued.key + 'x')).toBeNull();
  });

  it('rejects a revoked key', async () => {
    await runAsTenant(pool, T, async (c) => {
      await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [issued.id]);
    });
    expect(await createApiKeyResolver(pool)(issued.key)).toBeNull();
  });
});

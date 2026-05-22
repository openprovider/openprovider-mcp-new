import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createPgTokenCache } from '../../../src/openprovider/token-cache-pg.js';

const T = '00000000-0000-0000-0000-00000000060a';

describe('pg token cache integration', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  const dek = randomBytes(32);

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 't')`, [T]);
      await c.query(`INSERT INTO openprovider_accounts (tenant_id, username) VALUES ($1, 'u')`, [
        T,
      ]);
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('round-trips a cached token under RLS', async () => {
    await runAsTenant(pool, T, async (client) => {
      const cache = createPgTokenCache({
        client,
        getDek: () => Promise.resolve(Buffer.from(dek)),
      });
      await cache.set(T, { token: 'jwt-abc', expiresAt: new Date(Date.now() + 3600_000) });
      const got = await cache.get(T);
      expect(got?.token).toBe('jwt-abc');
    });
  });

  it('clear() blanks the cached token fields', async () => {
    await runAsTenant(pool, T, async (client) => {
      const cache = createPgTokenCache({
        client,
        getDek: () => Promise.resolve(Buffer.from(dek)),
      });
      await cache.set(T, { token: 'jwt-clear', expiresAt: new Date(Date.now() + 3600_000) });
      await cache.clear(T);
      const got = await cache.get(T);
      expect(got).toBeNull();
    });
  });
});

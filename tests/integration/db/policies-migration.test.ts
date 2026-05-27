import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner } from '../_helpers/db.js';

describe('migration 0008 + default policy seeding', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await fixture?.stop();
  });

  it('seeds a default policy when a tenant is provisioned', async () => {
    // signup_tenant (local auth) provisions a tenant + owner and seeds the default policy.
    const seeded = await seedTenantOwner(pool, 'p@example.com', 'x-hash-policy');
    const tenantId = seeded.tenant_id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_role');
      await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);
      const p = await c.query<{ doc: { spend_caps: { limit_eur: number } } }>(
        'SELECT doc FROM policies',
      );
      expect(p.rows[0]?.doc.spend_caps.limit_eur).toBe(0);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});

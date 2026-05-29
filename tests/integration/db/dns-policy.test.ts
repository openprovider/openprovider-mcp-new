import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner } from '../_helpers/db.js';

describe('migration 0015 dns default policy', () => {
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

  it('a freshly provisioned tenant has the new dns tool modes', async () => {
    const seeded = await seedTenantOwner(pool, 'b2-dns-policy@example.com', 'x-hash-dns');
    const tenantId = seeded.tenant_id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_role');
      await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);
      const r = await c.query<{ doc: Record<string, unknown> }>('SELECT doc FROM policies');
      const tools = r.rows[0].doc['tools'] as Record<string, string>;
      expect(tools['create_dns_zone']).toBe('allow');
      expect(tools['update_dns_zone']).toBe('allow');
      expect(tools['delete_dns_zone']).toBe('confirm');
      expect(tools['delete_ns_group']).toBe('confirm');
      expect(tools['create_domain_token']).toBe('allow');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner } from '../_helpers/db.js';

describe('migration 0019 email default policy', () => {
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

  it('a freshly provisioned tenant has the new email tool modes', async () => {
    const seeded = await seedTenantOwner(pool, 'b6-email-policy@example.com', 'x-hash-email');
    const tenantId = seeded.tenant_id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_role');
      await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);
      const r = await c.query<{ doc: Record<string, unknown> }>('SELECT doc FROM policies');
      const tools = r.rows[0].doc['tools'] as Record<string, string>;
      expect(tools['create_email_template']).toBe('allow');
      expect(tools['delete_email_template']).toBe('confirm');
      expect(tools['start_email_verification']).toBe('allow');
      expect(tools['create_dmarc']).toBe('allow');
      expect(tools['dmarc_sso_login']).toBe('allow');
      expect(tools['delete_dmarc']).toBe('confirm');
      expect(tools['create_spam_experts_domain']).toBe('allow');
      expect(tools['delete_spam_experts_domain']).toBe('confirm');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});

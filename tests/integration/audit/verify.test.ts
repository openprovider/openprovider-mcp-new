import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { verifyTenantChain } from '../../../scripts/audit-verify.js';

const T = '00000000-0000-0000-0000-0000000000f4';

describe('verify-chain', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

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
      for (const e of ['a', 'b', 'c', 'd']) {
        await c.query(
          `INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type, request_args)
           VALUES ($1,'system','s',$2,$3)`,
          [T, e, JSON.stringify({ n: e })],
        );
      }
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('verifies an intact chain', async () => {
    const res = await verifyTenantChain(pool, T);
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(4);
  });

  it('detects a tampered row (mutate event_type with the migration/superuser role bypassing app_role)', async () => {
    // The migration role (testcontainer superuser) can UPDATE despite the app_role append-only grant.
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE audit_events SET event_type = 'TAMPERED'
         WHERE tenant_id = $1 AND event_type = 'b'`,
        [T],
      );
    } finally {
      c.release();
    }
    const res = await verifyTenantChain(pool, T);
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBeTruthy();
  });
});

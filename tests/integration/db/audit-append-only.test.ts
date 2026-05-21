import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const T = '00000000-0000-0000-0000-00000000040a';

describe('audit_events append-only grants', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1,'t')`, [T]);
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('inserts succeed but DELETE / UPDATE fail with insufficient privilege', async () => {
    await runAsTenant(pool, T, async (c) => {
      await c.query(
        `INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type)
         VALUES ($1, 'system', 'test', 'noop')`,
        [T],
      );
    });
    await expect(
      runAsTenant(pool, T, async (c) => {
        await c.query('DELETE FROM audit_events');
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runAsTenant(pool, T, async (c) => {
        await c.query('UPDATE audit_events SET event_type = $1', ['tampered']);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

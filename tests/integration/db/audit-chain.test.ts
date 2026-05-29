import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { GENESIS } from '../../../src/audit/chain.js';

const A = '00000000-0000-0000-0000-0000000000f1';
const B = '00000000-0000-0000-0000-0000000000f2';

async function insertEvent(c: pg.PoolClient, tenant: string, eventType: string) {
  await c.query(
    `INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type)
     VALUES ($1,'system','s',$2)`,
    [tenant, eventType],
  );
}

describe('audit chain trigger', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  // Dedicated pool for the concurrent-insert test so its connections are
  // never queued behind unrelated suite traffic (see: suite-contention flake).
  let chainPool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    chainPool = new pg.Pool({ connectionString: fixture.url, max: 20 });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants (id,name) VALUES ($1,'a'),($2,'b') ON CONFLICT DO NOTHING`,
        [A, B],
      );
    } finally {
      c.release();
    }
  }, 60_000);
  afterAll(async () => {
    await chainPool?.end();
    await pool.end();
    await fixture.stop();
  });

  it('populates prev/row hash; genesis is 32 zeros; chain links', async () => {
    await runAsTenant(pool, A, async (c) => {
      await insertEvent(c, A, 'e1');
      await insertEvent(c, A, 'e2');
      await insertEvent(c, A, 'e3');
      const r = await c.query<{ prev_hash: Buffer; row_hash: Buffer }>(
        `SELECT prev_hash, row_hash FROM audit_events WHERE tenant_id=$1 ORDER BY id`,
        [A],
      );
      expect(r.rows[0]!.prev_hash.equals(GENESIS)).toBe(true);
      expect(r.rows[1]!.prev_hash.equals(r.rows[0]!.row_hash)).toBe(true);
      expect(r.rows[2]!.prev_hash.equals(r.rows[1]!.row_hash)).toBe(true);
    });
  });

  it('per-tenant chains are independent (B genesis is zeros despite A having rows)', async () => {
    await runAsTenant(pool, B, async (c) => {
      await insertEvent(c, B, 'b1');
      const r = await c.query<{ prev_hash: Buffer }>(
        `SELECT prev_hash FROM audit_events WHERE tenant_id=$1 ORDER BY id LIMIT 1`,
        [B],
      );
      expect(r.rows[0]!.prev_hash.equals(GENESIS)).toBe(true);
    });
  });

  it('concurrent inserts for one tenant produce an unbroken linear chain', async () => {
    const T = '00000000-0000-0000-0000-0000000000f3';
    const seed = await pool.connect();
    try {
      await seed.query(`INSERT INTO tenants (id,name) VALUES ($1,'c') ON CONFLICT DO NOTHING`, [T]);
      // Delete any rows from prior runs so the chain always starts at genesis.
      await seed.query(`DELETE FROM audit_events WHERE tenant_id = $1`, [T]);
    } finally {
      seed.release();
    }
    // Use a dedicated pool (max: 20) so these 16 concurrent connections are
    // never queued behind other test-suite traffic on the shared pool (max: 10).
    // Concurrency raised to 16 to stress-test the per-tenant advisory lock.
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        runAsTenant(chainPool, T, (c) => insertEvent(c, T, `c${i}`)),
      ),
    );
    await runAsTenant(chainPool, T, async (c) => {
      const r = await c.query<{ prev_hash: Buffer; row_hash: Buffer }>(
        `SELECT prev_hash, row_hash FROM audit_events WHERE tenant_id=$1 ORDER BY chain_seq`,
        [T],
      );
      expect(r.rows).toHaveLength(16);
      expect(r.rows[0]!.prev_hash.equals(GENESIS)).toBe(true);
      for (let i = 1; i < r.rows.length; i++) {
        expect(r.rows[i]!.prev_hash.equals(r.rows[i - 1]!.row_hash)).toBe(true);
      }
    });
  }, 60_000);
});

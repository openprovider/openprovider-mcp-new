import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const TENANT_A = '00000000-0000-0000-0000-00000000020a';
const TENANT_B = '00000000-0000-0000-0000-00000000020b';

describe('RLS — tenant_keys', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 'a'), ($2, 'b')`, [TENANT_A, TENANT_B]);
      await c.query(
        `INSERT INTO tenant_keys (tenant_id, wrapped_dek, kms_key_arn)
         VALUES ($1, $3, 'arn:test'), ($2, $4, 'arn:test')`,
        [TENANT_A, TENANT_B, Buffer.from('a'), Buffer.from('b')],
      );
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('returns only own DEK', async () => {
    const rows = await runAsTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ wrapped_dek: Buffer }>('SELECT wrapped_dek FROM tenant_keys');
      return r.rows.map((x) => x.wrapped_dek.toString());
    });
    expect(rows).toEqual(['a']);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const A = '00000000-0000-0000-0000-00000000030a';
const B = '00000000-0000-0000-0000-00000000030b';

describe('RLS — tenant_secrets', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1,'a'),($2,'b')`, [A, B]);
      await c.query(
        `INSERT INTO tenant_secrets (tenant_id, name, ciphertext, nonce, auth_tag, version)
         VALUES ($1,'openprovider.password',$3,$3,$3,1),
                ($2,'openprovider.password',$4,$4,$4,1)`,
        [A, B, Buffer.from('a'), Buffer.from('b')],
      );
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('returns only own ciphertext', async () => {
    const rows = await runAsTenant(pool, A, async (c) => {
      const r = await c.query<{ ciphertext: Buffer }>(
        `SELECT ciphertext FROM tenant_secrets WHERE name = 'openprovider.password'`,
      );
      return r.rows.map((x) => x.ciphertext.toString());
    });
    expect(rows).toEqual(['a']);
  });
});

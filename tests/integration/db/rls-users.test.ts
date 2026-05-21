import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const TENANT_A = '00000000-0000-0000-0000-00000000010a';
const TENANT_B = '00000000-0000-0000-0000-00000000010b';

describe('RLS — users table', () => {
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
        `INSERT INTO users (id, tenant_id, email, oauth_subject, role)
         VALUES (gen_random_uuid(), $1, 'a@example.com', 'oauth-a', 'owner'),
                (gen_random_uuid(), $2, 'b@example.com', 'oauth-b', 'owner')`,
        [TENANT_A, TENANT_B],
      );
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('lists only the calling tenant users', async () => {
    const rows = await runAsTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ email: string }>('SELECT email FROM users ORDER BY email');
      return r.rows.map((x) => x.email);
    });
    expect(rows).toEqual(['a@example.com']);
  });

  it('rejects INSERT for a foreign tenant_id under RLS', async () => {
    await expect(
      runAsTenant(pool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO users (id, tenant_id, email, oauth_subject, role)
           VALUES (gen_random_uuid(), $1, 'evil@example.com', 'evil', 'owner')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security|new row violates|permission denied/);
  });
});

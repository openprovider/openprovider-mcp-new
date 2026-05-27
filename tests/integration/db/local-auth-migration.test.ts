import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';

describe('migration 0013 local auth schema', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres();
    pool = (await migratedDb(fixture.url)).pool;
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await fixture?.stop();
  });

  it('users has nullable password_hash and nullable oauth_subject', async () => {
    const c = await pool.connect();
    try {
      const r = await c.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name='users' AND column_name IN ('password_hash','oauth_subject')`,
      );
      const m = Object.fromEntries(r.rows.map((x) => [x.column_name, x.is_nullable]));
      expect(m['password_hash']).toBe('YES');
      expect(m['oauth_subject']).toBe('YES');
    } finally {
      c.release();
    }
  });

  it('password_resets table exists with RLS', async () => {
    const c = await pool.connect();
    try {
      const t = await c.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name='password_resets'`,
      );
      expect(t.rowCount).toBe(1);
      const rls = await c.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname='password_resets'`,
      );
      expect(rls.rows[0]!.relforcerowsecurity).toBe(true);
    } finally {
      c.release();
    }
  });
});

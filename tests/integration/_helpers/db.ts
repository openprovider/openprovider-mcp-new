import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from '../../../src/db/client.js';

export async function migratedDb(url: string) {
  const { db, pool } = createDb({ connectionString: url, applicationName: 'test' });
  await migrate(db, { migrationsFolder: './migrations' });
  return { db, pool };
}

export async function runAsTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    // SET LOCAL does not accept query parameters; set_config(..., true) does.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function seedTenantOwner(
  pool: pg.Pool,
  email = 'owner@test.local',
  passwordHash = 'x-not-a-real-hash',
): Promise<{ status: string; tenant_id: string; user_id: string; role: string }> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query('SELECT * FROM signup_tenant($1, $2)', [email, passwordHash]);
    return r.rows[0];
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
}

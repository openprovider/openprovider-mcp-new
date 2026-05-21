import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from '../../../src/db/client.js';

export async function migratedDb(url: string) {
  const { db, pool } = createDb({ connectionString: url, applicationName: 'test' });
  await migrate(db, { migrationsFolder: './migrations' });
  // Make subsequent pool clients assume app_role so RLS is exercised.
  // (Task 8 creates app_role; until then this SET ROLE will silently no-op
  // because the role doesn't exist yet — we'll wire it in once migrations exist.)
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
    await client.query('SET LOCAL app.current_tenant = $1', [tenantId]);
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

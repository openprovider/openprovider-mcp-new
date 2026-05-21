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
    await client.query(`SET LOCAL app.current_tenant = '${tenantId}'`);
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

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbConfig {
  connectionString: string;
  applicationName?: string;
}

export function createDb(config: DbConfig): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName ?? 'openprovider-mcp',
    max: 10,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function setTenantContext(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query('SET LOCAL app.current_tenant = $1', [tenantId]);
}

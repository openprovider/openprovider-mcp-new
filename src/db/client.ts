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
  // SET LOCAL does not accept query parameters; set_config(..., true) is the
  // parameter-safe equivalent for transaction-local GUCs.
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
}

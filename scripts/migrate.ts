import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/db/client.js';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is required');
  process.exit(1);
}

const { db, pool } = createDb({ connectionString: url, applicationName: 'migrator' });
await migrate(db, { migrationsFolder: './migrations' });
await pool.end();

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { createGcpKms } from '../src/secrets/gcp-kms.js';
import { createSecretsStore } from '../src/secrets/store.js';
import { createDbSecretsRepo } from '../src/secrets/db-repo.js';

// Usage:
//   tsx scripts/tenant-onboard.ts --tenant <uuid> --username <op-user> --password <op-pass>
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      username: { type: 'string' },
      password: { type: 'string' },
    },
  });
  if (!values.tenant || !values.username || !values.password) {
    console.error(
      'Usage: tenant:onboard --tenant <uuid> --username <op-user> --password <op-pass>',
    );
    process.exit(1);
  }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const kms = createGcpKms({ keyName: cfg.gcpKmsKeyName });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', values.tenant]);

    await client.query(
      `INSERT INTO openprovider_accounts (tenant_id, username)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username, status = 'connected'`,
      [values.tenant, values.username],
    );

    const store = createSecretsStore({
      kms,
      kmsKeyArn: cfg.gcpKmsKeyName,
      repo: createDbSecretsRepo(client),
    });
    await store.put(values.tenant, 'openprovider.password', Buffer.from(values.password, 'utf8'));

    await client.query('COMMIT');
    console.error(`Onboarded Openprovider account for tenant ${values.tenant}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

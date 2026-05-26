import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { createGcpKms } from '../src/secrets/gcp-kms.js';
import { onboardCredentials } from '../src/tenants/onboard-credentials.js';

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

    await onboardCredentials(
      { client, kms, kmsKeyName: cfg.gcpKmsKeyName },
      { tenantId: values.tenant, username: values.username, password: values.password },
    );

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

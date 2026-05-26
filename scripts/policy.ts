import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { getPolicy, upsertPolicy } from '../src/policies/repo.js';
import { PolicyDoc } from '../src/policies/schema.js';

async function main(): Promise<void> {
  const sub = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { tenant: { type: 'string' }, file: { type: 'string' } },
  });
  if ((sub !== 'show' && sub !== 'set') || !values.tenant) {
    console.error(
      'Usage: policy show --tenant <uuid> | policy set --tenant <uuid> --file <policy.json>',
    );
    process.exit(1);
  }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', values.tenant]);
    if (sub === 'show') {
      const doc = await getPolicy(client, values.tenant);
      console.error(JSON.stringify(doc, null, 2));
    } else {
      if (!values.file) {
        console.error('--file required for set');
        process.exit(1);
      }
      const doc = PolicyDoc.parse(JSON.parse(readFileSync(values.file, 'utf8')));
      await upsertPolicy(client, values.tenant, doc);
      console.error(`Policy updated for tenant ${values.tenant}`);
    }
    await client.query('COMMIT');
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { startLocalstackKms, type KmsFixture } from '../_helpers/localstack-kms.js';
import { createAwsKms } from '../../../src/secrets/aws-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import type pg from 'pg';

const TENANT = '00000000-0000-0000-0000-00000000050a';

describe('secrets/store integration', () => {
  let pgFixture: PgFixture;
  let kms: KmsFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    [pgFixture, kms] = await Promise.all([startPostgres(), startLocalstackKms()]);
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 't')`, [TENANT]);
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await Promise.all([pgFixture.stop(), kms.stop()]);
  });

  it('round-trips a real secret via real KMS', async () => {
    const kmsClient = createAwsKms({ region: 'eu-central-1', endpoint: kms.endpoint });
    await runAsTenant(pool, TENANT, async (client) => {
      const store = createSecretsStore({
        kms: kmsClient,
        kmsKeyArn: kms.keyArn,
        repo: createDbSecretsRepo(client),
      });
      await store.put(TENANT, 'openprovider.password', Buffer.from('s3cret'));
      const got = await store.get(TENANT, 'openprovider.password');
      expect(got?.toString()).toBe('s3cret');
    });
  });
});

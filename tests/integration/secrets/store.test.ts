import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createFakeKms } from '../../../src/secrets/fake-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import type pg from 'pg';

const TENANT = '00000000-0000-0000-0000-00000000050a';

describe('secrets/store integration', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    pgFixture = await startPostgres();
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
    await pgFixture.stop();
  });

  it('round-trips a real secret via fake KMS', async () => {
    const kms = createFakeKms();
    await runAsTenant(pool, TENANT, async (client) => {
      const store = createSecretsStore({
        kms,
        kmsKeyArn: 'fake-key',
        repo: createDbSecretsRepo(client),
      });
      await store.put(TENANT, 'openprovider.password', Buffer.from('s3cret'));
      const got = await store.get(TENANT, 'openprovider.password');
      expect(got?.toString()).toBe('s3cret');
    });
  });
});

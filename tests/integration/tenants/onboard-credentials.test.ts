import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createFakeKms } from '../../../src/secrets/fake-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import { onboardCredentials } from '../../../src/tenants/onboard-credentials.js';

const TENANT = '00000000-0000-0000-0000-00000000bb01';

describe('onboardCredentials integration', () => {
  let pgFixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    pgFixture = await startPostgres();
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 'test-tenant')`, [TENANT]);
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await pgFixture.stop();
  });

  it('upserts openprovider_accounts with username and status=connected, and password decrypts correctly', async () => {
    const kms = createFakeKms();
    const kmsKeyName = 'fake-key-name';

    await runAsTenant(pool, TENANT, async (client) => {
      await onboardCredentials(
        { client, kms, kmsKeyName },
        { tenantId: TENANT, username: 'op-user@example.com', password: 'sup3rS3cret' },
      );
    });

    // Assert openprovider_accounts row
    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ username: string; status: string }>(
        `SELECT username, status FROM openprovider_accounts WHERE tenant_id = $1`,
        [TENANT],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.username).toBe('op-user@example.com');
      expect(r.rows[0]!.status).toBe('connected');
    });

    // Assert password decrypts correctly via the store
    await runAsTenant(pool, TENANT, async (client) => {
      const store = createSecretsStore({
        kms,
        kmsKeyArn: kmsKeyName,
        repo: createDbSecretsRepo(client),
      });
      const plaintext = await store.get(TENANT, 'openprovider.password');
      expect(plaintext).not.toBeNull();
      expect(plaintext!.toString('utf8')).toBe('sup3rS3cret');
    });
  });

  it('upserts on conflict — updates username and keeps status=connected', async () => {
    const kms = createFakeKms();
    const kmsKeyName = 'fake-key-name';

    // First call
    await runAsTenant(pool, TENANT, async (client) => {
      await onboardCredentials(
        { client, kms, kmsKeyName },
        { tenantId: TENANT, username: 'first@example.com', password: 'pass1' },
      );
    });

    // Second call — should update username and password
    await runAsTenant(pool, TENANT, async (client) => {
      await onboardCredentials(
        { client, kms, kmsKeyName },
        { tenantId: TENANT, username: 'second@example.com', password: 'pass2' },
      );
    });

    await runAsTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ username: string; status: string }>(
        `SELECT username, status FROM openprovider_accounts WHERE tenant_id = $1`,
        [TENANT],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.username).toBe('second@example.com');
      expect(r.rows[0]!.status).toBe('connected');

      const store = createSecretsStore({
        kms,
        kmsKeyArn: kmsKeyName,
        repo: createDbSecretsRepo(client),
      });
      const plaintext = await store.get(TENANT, 'openprovider.password');
      expect(plaintext!.toString('utf8')).toBe('pass2');
    });
  });
});

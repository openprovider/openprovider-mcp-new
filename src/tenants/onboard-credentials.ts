import type pg from 'pg';
import type { Kms } from '../secrets/kms.js';
import { createSecretsStore } from '../secrets/store.js';
import { createDbSecretsRepo } from '../secrets/db-repo.js';

export async function onboardCredentials(
  deps: { client: pg.PoolClient; kms: Kms; kmsKeyName: string },
  input: { tenantId: string; username: string; password: string },
): Promise<void> {
  await deps.client.query(
    `INSERT INTO openprovider_accounts (tenant_id, username)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username, status = 'connected'`,
    [input.tenantId, input.username],
  );
  const store = createSecretsStore({
    kms: deps.kms,
    kmsKeyArn: deps.kmsKeyName,
    repo: createDbSecretsRepo(deps.client),
  });
  await store.put(input.tenantId, 'openprovider.password', Buffer.from(input.password, 'utf8'));
}

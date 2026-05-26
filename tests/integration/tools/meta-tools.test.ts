import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { upsertPolicy, proposeConfirmation } from '../../../src/policies/repo.js';
import { DEFAULT_POLICY } from '../../../src/policies/schema.js';
import { createListPendingConfirmationsTool } from '../../../src/tools/list-pending-confirmations.js';
import type { Principal } from '../../../src/auth/principal.js';

const T = '00000000-0000-0000-0000-0000000000d1';
const owner = (t: string): Principal => ({
  kind: 'user',
  tenantId: t,
  userId: 'u',
  subject: 's',
  scopes: [],
  role: 'owner',
});
const viewer = (t: string): Principal => ({
  kind: 'user',
  tenantId: t,
  userId: 'u',
  subject: 's',
  scopes: [],
  role: 'viewer',
});

describe('meta-tools integration', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]);
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('list_pending_confirmations shows the row to an owner, hides from a viewer', async () => {
    await runAsTenant(pool, T, async (c) => {
      await upsertPolicy(c, T, {
        ...DEFAULT_POLICY,
        spend_caps: { window: 'month', limit_eur: 100 },
      });
      await proposeConfirmation({
        client: c,
        tenantId: T,
        principalSubject: 's',
        toolName: 'register_domain',
        args: { domain: { name: 'a', extension: 'com' }, period: 1 },
        summaryText: 'reg a.com',
        estimatedCostCents: 1200,
        requiredApproverRoles: ['owner', 'admin'],
        ttlMs: 300_000,
      });
      const tool = createListPendingConfirmationsTool({ getClient: () => c });
      const asOwner = (await tool.handler({}, owner(T))) as unknown[];
      expect(asOwner.length).toBe(1);
      const asViewer = (await tool.handler({}, viewer(T))) as unknown[];
      expect(asViewer.length).toBe(0);
    });
  });
});

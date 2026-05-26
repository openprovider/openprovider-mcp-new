import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { withIdempotency, claimConfirmation } from '../../../src/policies/idempotency.js';
import { upsertPolicy, proposeConfirmation } from '../../../src/policies/repo.js';
import { DEFAULT_POLICY } from '../../../src/policies/schema.js';

const T = '00000000-0000-0000-0000-0000000000e2';

describe('idempotency integration', () => {
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

  it('withIdempotency executes once then replays', async () => {
    await runAsTenant(pool, T, async (c) => {
      const fn = vi.fn().mockResolvedValue({ handle: 'X' });
      const first = await withIdempotency(c, T, 'k-replay', 'create_contact', fn);
      expect(first.replayed).toBe(false);
      const second = await withIdempotency(c, T, 'k-replay', 'create_contact', fn);
      expect(second.replayed).toBe(true);
      expect(second.result).toEqual({ handle: 'X' });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  it('claimConfirmation: only the first claim wins', async () => {
    await runAsTenant(pool, T, async (c) => {
      await upsertPolicy(c, T, {
        ...DEFAULT_POLICY,
        spend_caps: { window: 'month', limit_eur: 100 },
      });
      const rec = await proposeConfirmation({
        client: c,
        tenantId: T,
        principalSubject: 's',
        toolName: 'register_domain',
        args: { domain: { name: 'a', extension: 'com' }, period: 1 },
        summaryText: 'r',
        estimatedCostCents: 1000,
        requiredApproverRoles: ['owner'],
        ttlMs: 300_000,
      });
      expect(await claimConfirmation(c, rec.id)).toBe(true); // first claim wins
      expect(await claimConfirmation(c, rec.id)).toBe(false); // already claimed
    });
  });
});

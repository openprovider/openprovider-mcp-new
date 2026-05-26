import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import {
  getPolicy,
  upsertPolicy,
  liveSpendCents,
  proposeConfirmation,
  loadConfirmation,
  settleConfirmation,
} from '../../../src/policies/repo.js';
import { DEFAULT_POLICY } from '../../../src/policies/schema.js';

const T = '00000000-0000-0000-0000-0000000000c1';

describe('policies/repo integration', () => {
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

  it('getPolicy returns + persists default when none exists', async () => {
    await runAsTenant(pool, T, async (c) => {
      const p = await getPolicy(c, T);
      expect(p.spend_caps.limit_eur).toBe(0);
    });
  });

  it('propose inserts a confirmation + pending reservation counted in live spend', async () => {
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
        summaryText: 'reg a.com',
        estimatedCostCents: 1500,
        requiredApproverRoles: ['owner', 'admin'],
        ttlMs: 300_000,
      });
      expect(rec.id).toBeTruthy();
      expect(await liveSpendCents(c, T)).toBe(1500);
    });
  });

  it('settled-released reservation drops out of live spend; committed stays', async () => {
    await runAsTenant(pool, T, async (c) => {
      const before = await liveSpendCents(c, T);
      const rec = await proposeConfirmation({
        client: c,
        tenantId: T,
        principalSubject: 's',
        toolName: 'register_domain',
        args: { domain: { name: 'b', extension: 'com' }, period: 1 },
        summaryText: 'reg b.com',
        estimatedCostCents: 1000,
        requiredApproverRoles: ['owner'],
        ttlMs: 300_000,
      });
      await settleConfirmation(c, rec.id, 'released');
      expect(await liveSpendCents(c, T)).toBe(before); // released no longer counts
    });
  });

  it('MARQUEE: concurrent proposals never overshoot the cap', async () => {
    const TENANT = '00000000-0000-0000-0000-0000000000c2';
    const seed = await pool.connect();
    try {
      await seed.query(`INSERT INTO tenants (id,name) VALUES ($1,'race')`, [TENANT]);
    } finally {
      seed.release();
    }
    // cap €100, each proposal €15 → at most 6 may hold pending (6*15=90 ≤ 100, 7*15=105 > 100).
    await runAsTenant(pool, TENANT, async (c) => {
      await upsertPolicy(c, TENANT, {
        ...DEFAULT_POLICY,
        spend_caps: { window: 'month', limit_eur: 100 },
      });
    });

    async function tryPropose(): Promise<'ok' | 'denied'> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_role');
        await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', TENANT]);
        await c.query('SELECT 1 FROM policies WHERE tenant_id = $1 FOR UPDATE', [TENANT]); // serialize
        const live = await liveSpendCents(c, TENANT);
        if (live + 1500 > 10000) {
          await c.query('COMMIT');
          return 'denied';
        }
        await proposeConfirmation({
          client: c,
          tenantId: TENANT,
          principalSubject: 's',
          toolName: 'register_domain',
          args: { domain: { name: 'r' + Math.random(), extension: 'com' }, period: 1 },
          summaryText: 'r',
          estimatedCostCents: 1500,
          requiredApproverRoles: ['owner'],
          ttlMs: 300_000,
        });
        await c.query('COMMIT');
        return 'ok';
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    }

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => tryPropose()));
    const ok = outcomes.filter((o) => o === 'ok').length;
    expect(ok).toBe(6);
    await runAsTenant(pool, TENANT, async (c) => {
      expect(await liveSpendCents(c, TENANT)).toBe(9000); // 6 * 1500, never exceeds 10000
    });
  }, 30_000);
});

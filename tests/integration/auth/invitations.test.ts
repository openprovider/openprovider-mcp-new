import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';

describe('migration 0012 invitations', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['inv_owner_sub', 'owner@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('inserts a pending invite scoped to the tenant under RLS', async () => {
    const id = await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'invitee@example.com', 'operator', 'tok-1', now() + interval '7 days')
         RETURNING id`,
        [tenantId],
      );
      return r.rows[0]!.id;
    });
    expect(id).toBeTruthy();
  });

  it('enforces the partial unique index: two pending invites for one email collide', async () => {
    await expect(
      runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
           VALUES ($1, 'invitee@example.com', 'viewer', 'tok-2', now() + interval '7 days')`,
          [tenantId],
        );
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('rejects role=owner via the CHECK constraint', async () => {
    await expect(
      runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
           VALUES ($1, 'owner2@example.com', 'owner', 'tok-3', now() + interval '7 days')`,
          [tenantId],
        );
      }),
    ).rejects.toThrow(/check|constraint/i);
  });

  it('allows two different tenants to each hold a pending invite for the same email', async () => {
    const c = await pool.connect();
    let tenant2: string;
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['inv_owner2_sub', 'owner2@example.com'],
      );
      tenant2 = r.rows[0]!.tenant_id;
    } finally {
      c.release();
    }
    const id = await runAsTenant(pool, tenant2, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'invitee@example.com', 'viewer', 'tok-t2', now() + interval '7 days')
         RETURNING id`,
        [tenant2],
      );
      return r.rows[0]!.id;
    });
    expect(id).toBeTruthy();
  });
});

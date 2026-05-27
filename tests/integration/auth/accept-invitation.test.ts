import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { acceptInvitation, emailHasUser } from '../../../src/auth/accept-invitation.js';

describe('accept-invitation wrappers', () => {
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
        ['aiw_owner', 'aiw-owner@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'aiw-invitee@example.com', 'admin', 'aiw-tok', now() + interval '7 days')`,
        [tenantId],
      );
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await fixture?.stop();
  });

  it('emailHasUser true for existing owner, false for unknown', async () => {
    expect(await emailHasUser(pool, 'aiw-owner@example.com')).toBe(true);
    expect(await emailHasUser(pool, 'ghost@example.com')).toBe(false);
  });

  it('acceptInvitation returns accepted + tenant + role for a valid token+email', async () => {
    const res = await acceptInvitation(pool, 'aiw-tok', 'aiw-invitee-sub', 'aiw-invitee@example.com');
    expect(res.status).toBe('accepted');
    if (res.status === 'accepted') {
      expect(res.tenantId).toBe(tenantId);
      expect(res.role).toBe('admin');
    }
  });

  it('acceptInvitation surfaces email_mismatch as a non-accepted status', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'aiw-mm@example.com', 'viewer', 'aiw-mm-tok', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const res = await acceptInvitation(pool, 'aiw-mm-tok', 'mm-sub', 'wrong@example.com');
    expect(res.status).toBe('email_mismatch');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant, seedTenantOwner } from '../_helpers/db.js';
import { acceptInvitation, emailHasUser } from '../../../src/auth/accept-invitation.js';

describe('accept-invitation wrappers', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const seed = await seedTenantOwner(pool, 'aiw-owner@example.com');
    tenantId = seed.tenant_id;
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

  it('acceptInvitation returns accepted + tenantId + role + email for a valid token', async () => {
    const res = await acceptInvitation(pool, 'aiw-tok', 'some-hash');
    expect(res.status).toBe('accepted');
    if (res.status === 'accepted') {
      expect(res.tenantId).toBe(tenantId);
      expect(res.role).toBe('admin');
      expect(res.email).toBe('aiw-invitee@example.com');
    }
  });

  it('acceptInvitation surfaces email_taken when invite email already belongs to an active user', async () => {
    // Insert an invite for the owner's email (already an active user)
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'aiw-owner@example.com', 'viewer', 'aiw-et-tok', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const res = await acceptInvitation(pool, 'aiw-et-tok', 'some-hash');
    expect(res.status).toBe('email_taken');
  });
});

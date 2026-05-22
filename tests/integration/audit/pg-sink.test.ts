import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createPgAuditSink } from '../../../src/audit/pg-sink.js';

const TENANT_A = '00000000-0000-0000-0000-00000000070a';
const TENANT_B = '00000000-0000-0000-0000-00000000070b';

describe('pg audit sink integration', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 'a'), ($2, 'b')`, [
        TENANT_A,
        TENANT_B,
      ]);
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('inserts an audit row tenant-scoped, with redacted args persisted as jsonb', async () => {
    await runAsTenant(pool, TENANT_A, async (client) => {
      const sink = createPgAuditSink(client);
      await sink({
        tenantId: TENANT_A,
        actorKind: 'user',
        actorSubject: 's-a',
        eventType: 'tool.call',
        toolName: 'check_domain',
        requestArgs: { domain: 'a.com', password: '[REDACTED]' },
      });
      const r = await client.query<{
        event_type: string;
        tool_name: string;
        request_args: { password: string };
      }>(`SELECT event_type, tool_name, request_args FROM audit_events`);
      expect(r.rows[0]?.event_type).toBe('tool.call');
      expect(r.rows[0]?.request_args.password).toBe('[REDACTED]');
    });
  });

  it('tenant B does not see tenant A audit rows under RLS', async () => {
    await runAsTenant(pool, TENANT_B, async (client) => {
      const r = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_events`);
      // Tenant B has not inserted anything; previous test's tenant A row is invisible.
      expect(r.rows[0]?.count).toBe('0');
    });
  });
});

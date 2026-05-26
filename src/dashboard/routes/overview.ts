import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireSession } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { getPolicy, liveSpendCents } from '../../policies/repo.js';
import { centsToEur } from '../../policies/money.js';

export function registerOverview(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/dashboard', { preHandler: requireSession }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;

    const data = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      // openprovider account status — may be absent
      const accountRow = await client.query<{ status: string }>(
        `SELECT status FROM openprovider_accounts WHERE tenant_id = $1`,
        [session.tenantId],
      );
      const accountStatus = accountRow.rows[0]?.status ?? 'not connected';

      // policy + live spend
      const policy = await getPolicy(client, session.tenantId);
      const spendCents = await liveSpendCents(client, session.tenantId);

      return {
        accountStatus,
        spendCapEur: policy.spend_caps.limit_eur,
        liveSpendEur: centsToEur(spendCents),
      };
    });

    return reply.view('overview', {
      csrf: session.csrf,
      ...data,
    });
  });
}

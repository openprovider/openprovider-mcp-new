import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Kms } from '../../secrets/kms.js';
import { requireRole, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { onboardCredentials } from '../../tenants/onboard-credentials.js';

export function registerOpenprovider(
  app: FastifyInstance,
  deps: { pool: pg.Pool; kms: Kms; kmsKeyName: string },
): void {
  // GET /dashboard/openprovider — render form (username pre-filled, password blank)
  app.get('/dashboard/openprovider', { preHandler: requireRole('owner') }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;

    const username = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const r = await client.query<{ username: string }>(
        `SELECT username FROM openprovider_accounts WHERE tenant_id = $1`,
        [session.tenantId],
      );
      return r.rows[0]?.username ?? '';
    });

    const ok = (req.query as { ok?: string }).ok === '1';

    return reply.view('openprovider', {
      csrf: session.csrf,
      username,
      ok,
      error: null,
    });
  });

  // POST /dashboard/openprovider — persist credentials
  app.post('/dashboard/openprovider', { preHandler: requireRole('owner') }, async (req, reply) => {
    if (!assertCsrf(req)) {
      return reply.code(403).send('Forbidden: CSRF token mismatch');
    }

    const session = (req as typeof req & { session: DashboardSession }).session;
    const body = req.body as { username?: string; password?: string; _csrf?: string };
    const username = (body.username ?? '').trim();
    const password = (body.password ?? '').trim();

    if (!username || !password) {
      return reply.view('openprovider', {
        csrf: session.csrf,
        username,
        ok: false,
        error: 'Username and password are required.',
      });
    }

    await withTenantConn(deps.pool, session.tenantId, async (client) => {
      await onboardCredentials(
        { client, kms: deps.kms, kmsKeyName: deps.kmsKeyName },
        { tenantId: session.tenantId, username, password },
      );
    });

    return reply.redirect('/dashboard/openprovider?ok=1');
  });
}

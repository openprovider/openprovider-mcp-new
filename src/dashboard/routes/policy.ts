import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireRole, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { getPolicy, upsertPolicy } from '../../policies/repo.js';
import { PolicyDoc } from '../../policies/schema.js';

export function registerPolicy(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // GET /dashboard/policy — render current policy JSON in a textarea
  app.get(
    '/dashboard/policy',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      const session = (req as typeof req & { session: DashboardSession }).session;

      const policy = await withTenantConn(deps.pool, session.tenantId, async (client) => {
        return getPolicy(client, session.tenantId);
      });

      const ok = (req.query as { ok?: string }).ok === '1';

      return reply.view('policy', {
        csrf: session.csrf,
        policyJson: JSON.stringify(policy, null, 2),
        ok,
        error: null,
      });
    },
  );

  // POST /dashboard/policy — validate + save
  app.post(
    '/dashboard/policy',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      if (!assertCsrf(req)) {
        return reply.code(403).send('Forbidden: CSRF token mismatch');
      }

      const session = (req as typeof req & { session: DashboardSession }).session;
      const body = req.body as { policy?: string; _csrf?: string };
      const raw = body.policy ?? '';

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid JSON';
        return reply.code(200).view('policy', {
          csrf: session.csrf,
          policyJson: raw,
          ok: false,
          error: `JSON parse error: ${message}`,
        });
      }

      // Validate with Zod
      const result = PolicyDoc.safeParse(parsed);
      if (!result.success) {
        const message = result.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        return reply.code(200).view('policy', {
          csrf: session.csrf,
          policyJson: raw,
          ok: false,
          error: `Validation error: ${message}`,
        });
      }

      await withTenantConn(deps.pool, session.tenantId, async (client) => {
        await upsertPolicy(client, session.tenantId, result.data, session.userId);
      });

      return reply.redirect('/dashboard/policy?ok=1');
    },
  );
}

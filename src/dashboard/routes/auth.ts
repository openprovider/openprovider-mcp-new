import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireSession, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { consumePasswordReset } from '../../auth/local-auth.js';
import { hashPassword, verifyPassword, assertPasswordPolicy } from '../../auth/password.js';

const RESET_MESSAGES: Record<string, string> = {
  invalid_token: 'That reset link is not valid.',
  expired: 'That reset link has expired. Ask an owner for a new one.',
  already_used: 'That reset link has already been used.',
};

export function registerAuthRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/dashboard/reset', (req, reply) => {
    const token = (req.query as { token?: string }).token ?? '';
    return reply.view('reset', { token, error: null, notice: null });
  });

  app.post('/dashboard/reset', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; password?: string };
    const token = (body.token ?? '').trim();
    const password = body.password ?? '';
    try { assertPasswordPolicy(password); }
    catch { void reply.code(400); return reply.view('reset', { token, error: 'Password must be at least 12 characters.', notice: null }); }
    const r = await consumePasswordReset(deps.pool, token, await hashPassword(password));
    if (r.status !== 'ok') {
      void reply.code(400);
      return reply.view('reset', { token, error: RESET_MESSAGES[r.status] ?? 'Could not reset password.', notice: null });
    }
    return reply.view('login', { error: null, notice: 'Password updated — please sign in.' });
  });

  app.post('/dashboard/account/password', { preHandler: requireSession }, async (req, reply) => {
    if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
    const session = (req as typeof req & { session: DashboardSession }).session;
    const body = (req.body ?? {}) as { current?: string; next?: string };
    const current = body.current ?? '';
    const next = body.next ?? '';
    try { assertPasswordPolicy(next); }
    catch { return reply.code(400).send('Password must be at least 12 characters.'); }
    const ok = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const r = await client.query<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2`, [session.userId, session.tenantId]);
      const hash = r.rows[0]?.password_hash;
      if (!hash || !(await verifyPassword(hash, current))) return false;
      await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2 AND tenant_id = $3`,
        [await hashPassword(next), session.userId, session.tenantId]);
      return true;
    });
    if (!ok) return reply.code(400).send('Current password is incorrect.');
    return reply.redirect('/dashboard');
  });
}

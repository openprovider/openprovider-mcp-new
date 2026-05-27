import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireSession, setSession, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { acceptInvitation } from '../../auth/accept-invitation.js';

const ACCEPT_MESSAGES: Record<string, string> = {
  invalid_token: 'That invitation link is not valid.',
  already_accepted: 'That invitation has already been used.',
  expired: 'That invitation has expired. Ask an owner to send a new one.',
  email_mismatch: 'This invitation was sent to a different email address.',
  already_member: 'Your account already belongs to a workspace.',
};

export function registerAccept(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // GET /dashboard/accept — show the invite carried in ?token= for the logged-in user to accept.
  app.get('/dashboard/accept', { preHandler: requireSession }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;
    const token = (req.query as { token?: string }).token ?? '';
    return reply.view('accept', { csrf: session.csrf, token, error: null });
  });

  // POST /dashboard/accept — accept the invite, then upgrade the session to a full tenant session.
  app.post('/dashboard/accept', { preHandler: requireSession }, async (req, reply) => {
    if (!assertCsrf(req)) {
      return reply.code(403).send('Forbidden: CSRF token mismatch');
    }
    const session = (req as typeof req & { session: DashboardSession }).session;
    const body = req.body as { token?: string };
    const token = (body.token ?? '').trim();
    const email = session.email ?? '';

    const result = await acceptInvitation(deps.pool, token, session.subject, email);
    if (result.status !== 'accepted') {
      void reply.code(400);
      return reply.view('accept', {
        csrf: session.csrf,
        token,
        error: ACCEPT_MESSAGES[result.status] ?? 'Could not accept invitation.',
      });
    }

    setSession(reply, {
      tenantId: result.tenantId,
      userId: result.userId,
      subject: session.subject,
      role: result.role,
      email,
    });
    return reply.redirect('/dashboard');
  });
}

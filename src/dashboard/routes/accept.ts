import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { setSession } from '../session.js';
import { acceptInvitation } from '../../auth/accept-invitation.js';
import { hashPassword, assertPasswordPolicy } from '../../auth/password.js';

const ACCEPT_MESSAGES: Record<string, string> = {
  invalid_token: 'That invitation link is not valid.',
  already_accepted: 'That invitation has already been used.',
  expired: 'That invitation has expired. Ask an owner to send a new one.',
  email_taken: 'An account already exists for that email. Try signing in.',
};

export function registerAccept(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/dashboard/accept', (req, reply) => {
    const token = (req.query as { token?: string }).token ?? '';
    return reply.view('accept', { token, error: null });
  });

  app.post('/dashboard/accept', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; password?: string };
    const token = (body.token ?? '').trim();
    const password = body.password ?? '';
    try { assertPasswordPolicy(password); }
    catch { void reply.code(400); return reply.view('accept', { token, error: 'Password must be at least 12 characters.' }); }

    const hash = await hashPassword(password);
    const result = await acceptInvitation(deps.pool, token, hash);
    if (result.status !== 'accepted') {
      void reply.code(400);
      return reply.view('accept', { token, error: ACCEPT_MESSAGES[result.status] ?? 'Could not accept invitation.' });
    }
    setSession(reply, {
      tenantId: result.tenantId, userId: result.userId,
      subject: result.email, role: result.role, email: result.email,
    });
    return reply.redirect('/dashboard');
  });
}

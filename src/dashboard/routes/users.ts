import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { requireRole, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { emailHasUser } from '../../auth/accept-invitation.js';
import { canAssignRole } from '../user-admin.js';
import type { Role } from '../../auth/roles.js';

interface MemberRow {
  id: string;
  email: string;
  role: Role;
  status: string;
}
interface InviteRow {
  id: string;
  email: string;
  role: Role;
  expires_at: Date;
}

const INVITABLE_ROLES: ReadonlySet<string> = new Set(['admin', 'operator', 'viewer']);

async function loadPage(pool: pg.Pool, tenantId: string) {
  return withTenantConn(pool, tenantId, async (client) => {
    const members = await client.query<MemberRow>(
      `SELECT id, email, role, status FROM users
        WHERE tenant_id = $1 AND status <> 'deleted'
        ORDER BY created_at ASC`,
      [tenantId],
    );
    const invites = await client.query<InviteRow>(
      `SELECT id, email, role, expires_at FROM invitations
        WHERE tenant_id = $1 AND accepted_at IS NULL
        ORDER BY created_at DESC`,
      [tenantId],
    );
    return { members: members.rows, invites: invites.rows };
  });
}

export function registerUsers(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // GET /dashboard/users — member list + pending invites
  app.get('/dashboard/users', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;
    const { members, invites } = await loadPage(deps.pool, session.tenantId);
    return reply.view('users', {
      csrf: session.csrf,
      actorRole: session.role,
      actorUserId: session.userId,
      members,
      invites,
      newInviteLink: null,
      error: null,
    });
  });

  // POST /dashboard/users/invite — create a pending invite, show the link once
  app.post('/dashboard/users/invite', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
    if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
    const session = (req as typeof req & { session: DashboardSession }).session;
    const body = req.body as { email?: string; role?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const role = (body.role ?? '').trim();

    let error: string | null = null;
    let newInviteLink: string | null = null;

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk || !INVITABLE_ROLES.has(role)) {
      error = 'Provide a valid email and a role of admin, operator, or viewer.';
    } else if (!canAssignRole(session.role, role as Role)) {
      error = 'You may not assign that role.';
    } else if (await emailHasUser(deps.pool, email)) {
      error = 'That email already belongs to a user.';
    } else {
      const token = randomBytes(24).toString('base64url');
      try {
        await withTenantConn(deps.pool, session.tenantId, async (client) => {
          await client.query(
            `INSERT INTO invitations (tenant_id, email, role, token, created_by_user_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
            [session.tenantId, email, role, token, session.userId],
          );
        });
        newInviteLink = `/dashboard/accept?token=${token}`;
      } catch (err) {
        // Only the (tenant_id,email) partial-unique violation maps to the friendly message;
        // rethrow anything else so real DB failures surface instead of being masked.
        if ((err as { code?: string }).code === '23505') {
          error = 'There is already a pending invitation for that email.';
        } else {
          throw err;
        }
      }
    }

    const { members, invites } = await loadPage(deps.pool, session.tenantId);
    return reply.view('users', {
      csrf: session.csrf,
      actorRole: session.role,
      actorUserId: session.userId,
      members,
      invites,
      newInviteLink,
      error,
    });
  });
}

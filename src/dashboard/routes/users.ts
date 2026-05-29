import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { requireRole, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { emailHasUser } from '../../auth/accept-invitation.js';
import { canManage, canAssignRole, wouldOrphanOwners } from '../user-admin.js';
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

const INVITABLE_ROLES: ReadonlySet<string> = new Set(['admin', 'operator', 'viewer', 'auditor']);

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
      resetLink: null,
      error: null,
    });
  });

  // POST /dashboard/users/invite — create a pending invite, show the link once
  app.post(
    '/dashboard/users/invite',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
      const session = (req as typeof req & { session: DashboardSession }).session;
      const body = req.body as { email?: string; role?: string };
      const email = (body.email ?? '').trim().toLowerCase();
      const role = (body.role ?? '').trim();

      let error: string | null = null;
      let newInviteLink: string | null = null;

      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailOk || !INVITABLE_ROLES.has(role)) {
        error = 'Provide a valid email and a role of admin, operator, viewer, or auditor.';
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
        resetLink: null,
        error,
      });
    },
  );

  // POST /dashboard/users/:id/role — change a member's role
  app.post(
    '/dashboard/users/:id/role',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
      const session = (req as typeof req & { session: DashboardSession }).session;
      const { id } = req.params as { id: string };
      const newRole = ((req.body as { role?: string }).role ?? '').trim();

      if (!INVITABLE_ROLES.has(newRole)) return reply.code(400).send('Invalid role.');

      const outcome = await withTenantConn(deps.pool, session.tenantId, async (client) => {
        const t = await client.query<{ role: Role; status: string }>(
          `SELECT role, status FROM users WHERE id = $1 AND tenant_id = $2`,
          [id, session.tenantId],
        );
        const target = t.rows[0];
        if (!target || target.status === 'deleted') return { code: 404 as const };
        if (!canManage(session.role, target.role)) return { code: 403 as const };
        if (!canAssignRole(session.role, newRole as Role)) return { code: 403 as const };
        const owners = await client.query(
          `SELECT id FROM users
          WHERE tenant_id = $1 AND role = 'owner' AND status <> 'deleted'
          FOR UPDATE`,
          [session.tenantId],
        );
        if (wouldOrphanOwners(target.role, owners.rowCount ?? 0, { newRole: newRole as Role })) {
          return { code: 400 as const };
        }
        await client.query(`UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3`, [
          newRole,
          id,
          session.tenantId,
        ]);
        return { code: 200 as const };
      });

      if (outcome.code !== 200) {
        const body =
          outcome.code === 403
            ? 'Forbidden'
            : outcome.code === 404
              ? 'User not found'
              : 'Cannot remove or demote the last owner.';
        return reply.code(outcome.code).send(body);
      }
      const { members, invites } = await loadPage(deps.pool, session.tenantId);
      return reply.view('users', {
        csrf: session.csrf,
        actorRole: session.role,
        actorUserId: session.userId,
        members,
        invites,
        newInviteLink: null,
        resetLink: null,
        error: null,
      });
    },
  );

  // POST /dashboard/users/:id/remove — soft-delete + revoke the user's API keys
  app.post(
    '/dashboard/users/:id/remove',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
      const session = (req as typeof req & { session: DashboardSession }).session;
      const { id } = req.params as { id: string };

      const outcome = await withTenantConn(deps.pool, session.tenantId, async (client) => {
        const t = await client.query<{ role: Role; status: string }>(
          `SELECT role, status FROM users WHERE id = $1 AND tenant_id = $2`,
          [id, session.tenantId],
        );
        const target = t.rows[0];
        if (!target || target.status === 'deleted') return { code: 404 as const };
        if (!canManage(session.role, target.role)) return { code: 403 as const };
        const owners = await client.query(
          `SELECT id FROM users
          WHERE tenant_id = $1 AND role = 'owner' AND status <> 'deleted'
          FOR UPDATE`,
          [session.tenantId],
        );
        if (wouldOrphanOwners(target.role, owners.rowCount ?? 0, 'remove'))
          return { code: 400 as const };
        await client.query(`UPDATE users SET status = 'deleted' WHERE id = $1 AND tenant_id = $2`, [
          id,
          session.tenantId,
        ]);
        await client.query(
          `UPDATE api_keys SET revoked_at = now() WHERE created_by_user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
          [id, session.tenantId],
        );
        return { code: 200 as const };
      });

      if (outcome.code !== 200) {
        const body =
          outcome.code === 403
            ? 'Forbidden'
            : outcome.code === 404
              ? 'User not found'
              : 'Cannot remove or demote the last owner.';
        return reply.code(outcome.code).send(body);
      }
      const { members, invites } = await loadPage(deps.pool, session.tenantId);
      return reply.view('users', {
        csrf: session.csrf,
        actorRole: session.role,
        actorUserId: session.userId,
        members,
        invites,
        newInviteLink: null,
        resetLink: null,
        error: null,
      });
    },
  );

  // POST /dashboard/invitations/:id/revoke — delete a pending invite (frees the unique-email slot)
  app.post(
    '/dashboard/invitations/:id/revoke',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
      const session = (req as typeof req & { session: DashboardSession }).session;
      const { id } = req.params as { id: string };
      await withTenantConn(deps.pool, session.tenantId, async (client) => {
        await client.query(
          `DELETE FROM invitations WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL`,
          [id, session.tenantId],
        );
      });
      const { members, invites } = await loadPage(deps.pool, session.tenantId);
      return reply.view('users', {
        csrf: session.csrf,
        actorRole: session.role,
        actorUserId: session.userId,
        members,
        invites,
        newInviteLink: null,
        resetLink: null,
        error: null,
      });
    },
  );

  // POST /dashboard/users/:id/reset — issue a single-use password-reset link
  app.post(
    '/dashboard/users/:id/reset',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
      const session = (req as typeof req & { session: DashboardSession }).session;
      const { id } = req.params as { id: string };
      const token = randomBytes(32).toString('base64url');
      const outcome = await withTenantConn(deps.pool, session.tenantId, async (client) => {
        const t = await client.query<{ role: Role; status: string }>(
          `SELECT role, status FROM users WHERE id = $1 AND tenant_id = $2`,
          [id, session.tenantId],
        );
        const target = t.rows[0];
        if (!target || target.status === 'deleted') return { code: 404 as const };
        if (!canManage(session.role, target.role)) return { code: 403 as const };
        await client.query(
          `INSERT INTO password_resets (tenant_id, user_id, token, expires_at) VALUES ($1,$2,$3, now()+interval '1 hour')`,
          [session.tenantId, id, token],
        );
        return { code: 200 as const };
      });
      if (outcome.code !== 200)
        return reply.code(outcome.code).send(outcome.code === 403 ? 'Forbidden' : 'User not found');
      const { members, invites } = await loadPage(deps.pool, session.tenantId);
      return reply.view('users', {
        csrf: session.csrf,
        actorRole: session.role,
        actorUserId: session.userId,
        members,
        invites,
        newInviteLink: null,
        resetLink: `/dashboard/reset?token=${token}`,
        error: null,
      });
    },
  );
}

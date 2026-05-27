import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { ROLES, type Role } from '../auth/roles.js';

export interface DashboardSession {
  tenantId: string;
  userId: string;
  subject: string;
  role: Role;
  csrf: string;
  /** Verified email — used by dashboard pages. */
  email?: string;
}

const COOKIE = 'op_dash';

/**
 * Write a signed session cookie and return the CSRF token embedded in it.
 * The caller is responsible for passing `csrf` to the rendered template.
 */
export function setSession(reply: FastifyReply, s: Omit<DashboardSession, 'csrf'>): string {
  const csrf = randomBytes(16).toString('hex');
  const value = JSON.stringify({ ...s, csrf });
  void reply.setCookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    signed: true,
    secure: false,
  });
  return csrf;
}

/**
 * Read + verify the signed session cookie. Returns null on any failure.
 */
export function readSession(req: FastifyRequest): DashboardSession | null {
  const raw = req.cookies[COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    const parsed = JSON.parse(unsigned.value) as DashboardSession;
    // Reject legacy/tampered cookies lacking a valid role (e.g. cookies minted
    // before the role field existed) — treat as no session so the caller redirects to login.
    if (!parsed.role || !ROLES.has(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Clear the session cookie (redirect to login is the caller's responsibility).
 */
export function clearSession(reply: FastifyReply): void {
  void reply.clearCookie(COOKIE, { path: '/' });
}

/**
 * Fastify preHandler: redirect to /dashboard/login when no valid session exists,
 * otherwise stash the session on req for downstream handlers.
 */
export function requireSession(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (e?: Error) => void,
): void {
  const s = readSession(req);
  if (!s) {
    void reply.redirect('/dashboard/login');
    return;
  }
  (req as FastifyRequest & { session?: DashboardSession }).session = s;
  done();
}

/**
 * preHandler factory: 403 when the session role is not in `allowed`.
 * Redirects unauthenticated users to login.
 * Stashes the session on req like requireSession, so use it INSTEAD of requireSession.
 */
export function requireRole(...allowed: Role[]) {
  return function (req: FastifyRequest, reply: FastifyReply, done: (e?: Error) => void): void {
    const s = readSession(req);
    if (!s) {
      void reply.redirect('/dashboard/login');
      return;
    }
    if (!allowed.includes(s.role)) {
      void reply.code(403).send('Forbidden: insufficient role');
      return;
    }
    (req as FastifyRequest & { session?: DashboardSession }).session = s;
    done();
  };
}

/**
 * CSRF check: body._csrf must equal the session's csrf token.
 * Returns false if session is missing or tokens do not match.
 */
export function assertCsrf(req: FastifyRequest): boolean {
  const s = readSession(req);
  const body = req.body as { _csrf?: string } | undefined;
  return !!s && !!body?._csrf && body._csrf === s.csrf;
}

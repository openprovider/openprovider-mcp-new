import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import { Eta } from 'eta';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSession, clearSession } from './session.js';

// Derive __dirname for ESM — works even if import.meta.dirname is undefined (Node <20.11).
const __dirname =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));

export interface DashboardDeps {
  cookieSecret: string;
  /** Return the WorkOS hosted-login URL (no PKCE needed for this server-side flow). */
  buildAuthorizationUrl: () => string;
  /** Exchange the code for a user object (WorkOS userManagement.authenticateWithCode). */
  authenticateWithCode: (
    code: string,
  ) => Promise<{ userId: string; email: string; subject: string }>;
  /** Resolve (or provision) the tenant from WorkOS user identifiers. */
  resolveTenant: (subject: string, email: string) => Promise<{ tenantId: string; userId: string }>;
  /** Tasks 7–8 attach page routes via this hook. Pass a no-op for the scaffold alone. */
  registerPages: (app: FastifyInstance) => void;
}

/**
 * Register the dashboard onto the Fastify app.
 *
 * Mounts:
 *   GET  /dashboard/login           → redirect to WorkOS hosted login
 *   GET  /dashboard/login/callback  → exchange code, set session, redirect /dashboard
 *   POST /dashboard/logout          → clear session, redirect /dashboard/login
 *
 * Then calls deps.registerPages(app) so Tasks 7–8 can attach their routes.
 */
export async function registerDashboard(app: FastifyInstance, deps: DashboardDeps): Promise<void> {
  const viewsDir = path.join(__dirname, 'views');
  const publicDir = path.join(__dirname, 'public');

  await app.register(fastifyCookie, { secret: deps.cookieSecret });
  await app.register(fastifyFormbody);
  await app.register(fastifyView, {
    engine: { eta: new Eta({ views: viewsDir }) },
    root: viewsDir,
    viewExt: 'eta',
  });
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/dashboard/static/',
  });

  // GET /dashboard/login — redirect to WorkOS hosted-login page
  app.get('/dashboard/login', async (_req, reply) => {
    return reply.redirect(deps.buildAuthorizationUrl());
  });

  // GET /dashboard/login/callback — exchange WorkOS code for session
  app.get('/dashboard/login/callback', async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    if (!code) {
      void reply.code(400);
      return reply.view('login', { error: 'missing code' });
    }
    try {
      const user = await deps.authenticateWithCode(code);
      const t = await deps.resolveTenant(user.subject, user.email);
      setSession(reply, { tenantId: t.tenantId, userId: t.userId, subject: user.subject });
      return reply.redirect('/dashboard');
    } catch (err) {
      void reply.code(400);
      const message = err instanceof Error ? err.message : 'authentication failed';
      return reply.view('login', { error: message });
    }
  });

  // POST /dashboard/logout — clear session and redirect to login
  app.post('/dashboard/logout', async (_req, reply) => {
    clearSession(reply);
    return reply.redirect('/dashboard/login');
  });

  // Tasks 7–8 attach their page routes here
  deps.registerPages(app);
}

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import { Eta } from 'eta';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSession, clearSession } from './session.js';
import type { Role } from '../auth/roles.js';

// Derive __dirname for ESM — works even if import.meta.dirname is undefined (Node <20.11).
const __dirname =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));

export type SignupOutcome =
  | { status: 'created'; tenantId: string; userId: string; role: Role; email: string }
  | { status: 'email_taken' }
  | { status: 'invalid_password' };

export type LoginOutcome =
  | { ok: true; tenantId: string; userId: string; role: Role; email: string }
  | { ok: false };

export interface DashboardDeps {
  cookieSecret: string;
  cookieSecure: boolean;
  signup: (email: string, password: string) => Promise<SignupOutcome>;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  /** Tasks 7–8 attach page routes via this hook. Pass a no-op for the scaffold alone. */
  registerPages: (app: FastifyInstance) => void;
}

/**
 * Register the dashboard onto the Fastify app.
 *
 * Mounts:
 *   GET  /dashboard/login    → render email+password login form
 *   POST /dashboard/login    → authenticate, set session, redirect /dashboard
 *   GET  /dashboard/signup   → render signup form
 *   POST /dashboard/signup   → create account, set session, redirect /dashboard
 *   POST /dashboard/logout   → clear session, redirect /dashboard/login
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

  await app.register(rateLimit, { global: false });

  // GET /dashboard/login — render the email+password login form
  app.get('/dashboard/login', (_req, reply) => reply.view('login', { error: null, notice: null }));

  // POST /dashboard/login — authenticate and set session
  app.post(
    '/dashboard/login',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.ip },
      },
    },
    async (req, reply) => {
      const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
      const r = await deps.login((email ?? '').trim().toLowerCase(), password ?? '');
      if (!r.ok) {
        void reply.code(401);
        return reply.view('login', { error: 'Invalid email or password', notice: null });
      }
      setSession(
        reply,
        { tenantId: r.tenantId, userId: r.userId, subject: r.email, role: r.role, email: r.email },
        { secure: deps.cookieSecure },
      );
      return reply.redirect('/dashboard');
    },
  );

  // GET /dashboard/signup — render the signup form
  app.get('/dashboard/signup', (_req, reply) => reply.view('signup', { error: null }));

  // POST /dashboard/signup — create account and set session
  app.post('/dashboard/signup', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const r = await deps.signup((email ?? '').trim().toLowerCase(), password ?? '');
    if (r.status === 'email_taken') {
      void reply.code(409);
      return reply.view('signup', { error: 'That email is already in use.' });
    }
    if (r.status === 'invalid_password') {
      void reply.code(400);
      return reply.view('signup', { error: 'Password must be at least 12 characters.' });
    }
    setSession(
      reply,
      { tenantId: r.tenantId, userId: r.userId, subject: r.email, role: r.role, email: r.email },
      { secure: deps.cookieSecure },
    );
    return reply.redirect('/dashboard');
  });

  // POST /dashboard/logout — clear session and redirect to login
  app.post('/dashboard/logout', async (_req, reply) => {
    clearSession(reply);
    return reply.redirect('/dashboard/login');
  });

  // Tasks 7–8 attach their page routes here
  deps.registerPages(app);
}

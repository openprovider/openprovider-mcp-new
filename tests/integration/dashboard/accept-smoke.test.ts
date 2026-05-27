import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sign } from '@fastify/cookie';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerAccept } from '../../../src/dashboard/routes/accept.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

const SECRET = 'accept-smoke-secret-32-chars-long!!';

function cookie(s: DashboardSession): string {
  return `op_dash=${sign(JSON.stringify(s), SECRET)}`;
}

describe('accept route smoke', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    app = Fastify();
    await registerDashboard(app, {
      cookieSecret: SECRET,
      buildAuthorizationUrl: () => 'https://auth.example.com/login',
      authenticateWithCode: async () => ({ userId: 'u', email: 'p@example.com', subject: 'sub_p' }),
      resolveTenant: async () => ({ status: 'pending_invite' }),
      registerPages: (pageApp) => registerAccept(pageApp, { pool }),
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await fixture?.stop();
  });

  it('GET /dashboard/accept with a pending session renders the form', async () => {
    const s: DashboardSession = { tenantId: '', userId: '', subject: 'sub_p', role: 'viewer', csrf: 'c1', pending: true, email: 'p@example.com' };
    const res = await app.inject({ method: 'GET', url: '/dashboard/accept?token=abc', headers: { cookie: cookie(s) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Accept Invitation');
    expect(res.body).toContain('abc');
  });

  it('POST /dashboard/accept with bad CSRF → 403', async () => {
    const s: DashboardSession = { tenantId: '', userId: '', subject: 'sub_p', role: 'viewer', csrf: 'c1', pending: true, email: 'p@example.com' };
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/accept',
      headers: { cookie: cookie(s), 'content-type': 'application/x-www-form-urlencoded' },
      payload: '_csrf=WRONG&token=abc',
    });
    expect(res.statusCode).toBe(403);
  });
});

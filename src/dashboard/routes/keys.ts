import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireSession, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { issueApiKey } from '../../auth/api-key.js';

interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

function keyStatus(row: ApiKeyRow): string {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return 'expired';
  return 'active';
}

export function registerKeys(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // GET /dashboard/keys — list all api_keys for this tenant
  app.get('/dashboard/keys', { preHandler: requireSession }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;

    const keys = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const r = await client.query<ApiKeyRow>(
        `SELECT id, prefix, name, last_used_at, revoked_at, expires_at, created_at
           FROM api_keys
          WHERE tenant_id = $1
          ORDER BY created_at DESC`,
        [session.tenantId],
      );
      return r.rows;
    });

    return reply.view('keys', {
      csrf: session.csrf,
      keys: keys.map((k) => ({ ...k, status: keyStatus(k) })),
      newKey: null,
    });
  });

  // POST /dashboard/keys/issue — issue a new API key; show plaintext ONCE
  app.post('/dashboard/keys/issue', { preHandler: requireSession }, async (req, reply) => {
    if (!assertCsrf(req)) {
      return reply.code(403).send('Forbidden: CSRF token mismatch');
    }

    const session = (req as typeof req & { session: DashboardSession }).session;
    const body = req.body as { name?: string; _csrf?: string };
    const name = (body.name ?? '').trim() || 'API Key';

    const { issued, keys } = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const issuedKey = await issueApiKey(client, {
        tenantId: session.tenantId,
        name,
        scopes: ['mcp:read', 'mcp:write'],
        createdByUserId: session.userId,
      });

      // Reload the full list
      const r = await client.query<ApiKeyRow>(
        `SELECT id, prefix, name, last_used_at, revoked_at, expires_at, created_at
           FROM api_keys
          WHERE tenant_id = $1
          ORDER BY created_at DESC`,
        [session.tenantId],
      );
      return { issued: issuedKey, keys: r.rows };
    });

    return reply.view('keys', {
      csrf: session.csrf,
      keys: keys.map((k) => ({ ...k, status: keyStatus(k) })),
      // Plaintext key shown ONCE — not persisted, not re-renderable
      newKey: { id: issued.id, key: issued.key, prefix: issued.prefix, name },
    });
  });

  // POST /dashboard/keys/:id/revoke — revoke a specific key
  app.post('/dashboard/keys/:id/revoke', { preHandler: requireSession }, async (req, reply) => {
    if (!assertCsrf(req)) {
      return reply.code(403).send('Forbidden: CSRF token mismatch');
    }

    const session = (req as typeof req & { session: DashboardSession }).session;
    const { id } = req.params as { id: string };

    const keys = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      await client.query(
        `UPDATE api_keys SET revoked_at = now()
          WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
        [id, session.tenantId],
      );

      const r = await client.query<ApiKeyRow>(
        `SELECT id, prefix, name, last_used_at, revoked_at, expires_at, created_at
           FROM api_keys
          WHERE tenant_id = $1
          ORDER BY created_at DESC`,
        [session.tenantId],
      );
      return r.rows;
    });

    return reply.view('keys', {
      csrf: session.csrf,
      keys: keys.map((k) => ({ ...k, status: keyStatus(k) })),
      newKey: null,
    });
  });
}

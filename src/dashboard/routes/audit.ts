import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireSession } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';

interface AuditEventRow {
  id: string;
  event_type: string;
  tool_name: string | null;
  actor_subject: string;
  actor_kind: string;
  occurred_at: Date;
  request_args: unknown;
  error_code: string | null;
}

export function registerAudit(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // GET /dashboard/audit — paginated audit_events table
  app.get('/dashboard/audit', { preHandler: requireSession }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;
    const query = req.query as {
      event_type?: string;
      tool?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 500);
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);
    const eventType = query.event_type?.trim() || null;
    const tool = query.tool?.trim() || null;

    const { events, total } = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      // Build dynamic WHERE clause
      const conditions: string[] = ['ae.tenant_id = $1'];
      const params: unknown[] = [session.tenantId];
      let paramIdx = 2;

      if (eventType) {
        conditions.push(`ae.event_type = $${paramIdx++}`);
        params.push(eventType);
      }
      if (tool) {
        conditions.push(`ae.tool_name = $${paramIdx++}`);
        params.push(tool);
      }

      const where = conditions.join(' AND ');

      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_events ae WHERE ${where}`,
        params,
      );
      const totalCount = parseInt(countResult.rows[0]?.count ?? '0', 10);

      const eventsResult = await client.query<AuditEventRow>(
        `SELECT id, event_type, tool_name, actor_subject, actor_kind, occurred_at, request_args, error_code
             FROM audit_events ae
            WHERE ${where}
            ORDER BY occurred_at DESC
            LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      );

      return { events: eventsResult.rows, total: totalCount };
    });

    return reply.view('audit', {
      csrf: session.csrf,
      events,
      total,
      limit,
      offset,
      eventType: eventType ?? '',
      tool: tool ?? '',
      prevOffset: Math.max(offset - limit, 0),
      nextOffset: offset + limit,
      hasPrev: offset > 0,
      hasNext: offset + limit < total,
    });
  });

  // GET /dashboard/audit/export — stream NDJSON attachment
  app.get('/dashboard/audit/export', { preHandler: requireSession }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;

    // Stream all audit rows for the tenant as NDJSON
    const events = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const r = await client.query<AuditEventRow>(
        `SELECT id, event_type, tool_name, actor_subject, actor_kind, occurred_at, request_args, error_code
           FROM audit_events
          WHERE tenant_id = $1
          ORDER BY occurred_at ASC`,
        [session.tenantId],
      );
      return r.rows;
    });

    const ndjson = events.map((e) => JSON.stringify(e)).join('\n');

    return reply
      .code(200)
      .header('Content-Type', 'application/x-ndjson')
      .header('Content-Disposition', `attachment; filename="audit-${session.tenantId}.ndjson"`)
      .send(ndjson);
  });
}

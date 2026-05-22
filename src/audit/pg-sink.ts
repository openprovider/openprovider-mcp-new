import type pg from 'pg';
import type { AuditRow } from '../mcp/dispatch.js';

/**
 * Create an audit sink bound to a single pg PoolClient.
 *
 * The caller is responsible for the client's lifecycle (connect / release).
 * Within a request, the same `runAsTenant` transaction's client is reused so
 * audit_events rows land under the correct tenant RLS context.
 */
export function createPgAuditSink(client: pg.PoolClient) {
  return async (row: AuditRow): Promise<void> => {
    await client.query(
      `INSERT INTO audit_events
         (tenant_id, actor_kind, actor_subject, event_type, tool_name, request_args, result, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.tenantId,
        row.actorKind,
        row.actorSubject,
        row.eventType,
        row.toolName,
        row.requestArgs === undefined ? null : JSON.stringify(row.requestArgs),
        row.result === undefined ? null : JSON.stringify(row.result),
        row.errorCode ?? null,
      ],
    );
  };
}

import { createHash } from 'node:crypto';
import type pg from 'pg';

const WINDOW_MS = 10 * 60 * 1000;

export function idempotencyKeyFor(
  tool: string,
  args: unknown,
  tenantId: string,
  confirmationId?: string,
): string {
  if (confirmationId) return confirmationId;
  const canonical = JSON.stringify(args, Object.keys(args as object).sort());
  return createHash('sha256')
    .update(tool)
    .update('|')
    .update(canonical)
    .update('|')
    .update(tenantId)
    .digest('hex');
}

export async function withIdempotency<T>(
  client: pg.PoolClient,
  tenantId: string,
  key: string,
  toolName: string,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const hit = await client.query<{ result_json: T }>(
    `SELECT result_json FROM idempotency_records WHERE tenant_id = $1 AND key = $2 AND expires_at > now()`,
    [tenantId, key],
  );
  if (hit.rows[0]) return { result: hit.rows[0].result_json, replayed: true };
  const result = await fn();
  await client.query(
    `INSERT INTO idempotency_records (tenant_id, key, tool_name, result_json, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, key, toolName, JSON.stringify(result)],
  );
  return { result, replayed: false };
}

/** Atomically claim a confirmation for execution. Returns true if THIS caller won the claim. */
export async function claimConfirmation(
  client: pg.PoolClient,
  confirmationId: string,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE confirmations SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [confirmationId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Release a claim (on upstream failure) so the confirmation is re-approvable. */
export async function unclaimConfirmation(
  client: pg.PoolClient,
  confirmationId: string,
): Promise<void> {
  await client.query(`UPDATE confirmations SET consumed_at = NULL WHERE id = $1`, [confirmationId]);
}

export { WINDOW_MS };

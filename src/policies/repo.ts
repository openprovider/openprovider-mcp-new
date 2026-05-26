import { createHash } from 'node:crypto';
import type pg from 'pg';
import { PolicyDoc, DEFAULT_POLICY, requiredApproverRoles, type Role } from './schema.js';
import { parseEurString, centsToEur } from './money.js';

export function canonicalArgsHash(args: unknown, tenantId: string): Buffer {
  const canonical = JSON.stringify(args, Object.keys(args as object).sort());
  return createHash('sha256').update(canonical).update(tenantId).digest();
}

export interface ConfirmationRecord {
  id: string;
  toolName: string;
  summaryText: string;
  estimatedCostCents: number;
  requiredApproverRoles: Role[];
  expiresAt: Date;
}

/** Reads the tenant's policy; persists + returns DEFAULT_POLICY if no row exists. */
export async function getPolicy(client: pg.PoolClient, tenantId: string): Promise<PolicyDoc> {
  const r = await client.query<{ doc: unknown }>('SELECT doc FROM policies WHERE tenant_id = $1', [
    tenantId,
  ]);
  if (r.rows[0]) return PolicyDoc.parse(r.rows[0].doc);
  await client.query(
    `INSERT INTO policies (tenant_id, doc) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, JSON.stringify(DEFAULT_POLICY)],
  );
  return DEFAULT_POLICY;
}

export async function upsertPolicy(
  client: pg.PoolClient,
  tenantId: string,
  doc: PolicyDoc,
  userId?: string,
): Promise<void> {
  PolicyDoc.parse(doc);
  await client.query(
    `INSERT INTO policies (tenant_id, doc, version, updated_at, updated_by_user_id)
       VALUES ($1, $2, 1, now(), $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET doc = EXCLUDED.doc, version = policies.version + 1, updated_at = now(), updated_by_user_id = EXCLUDED.updated_by_user_id`,
    [tenantId, JSON.stringify(doc), userId ?? null],
  );
}

/** Live spend in cents for the current month window (committed + non-expired pending). */
export async function liveSpendCents(client: pg.PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(sr.amount_eur), 0)::text AS total
       FROM spend_reservations sr
      WHERE sr.tenant_id = $1
        AND sr.window_start = date_trunc('month', now())
        AND (sr.status = 'committed'
             OR (sr.status = 'pending'
                 AND EXISTS (SELECT 1 FROM confirmations c
                              WHERE c.id = sr.confirmation_id
                                AND c.expires_at > now() AND c.consumed_at IS NULL)))`,
    [tenantId],
  );
  return parseEurString(r.rows[0]?.total ?? '0');
}

export interface ProposeInput {
  client: pg.PoolClient;
  tenantId: string;
  principalSubject: string;
  toolName: string;
  args: unknown;
  summaryText: string;
  estimatedCostCents: number;
  requiredApproverRoles: Role[];
  ttlMs: number;
}

/** Inserts a confirmation + pending reservation. Caller has already SELECT…FOR UPDATE'd the policy row and run the engine. */
export async function proposeConfirmation(input: ProposeInput): Promise<ConfirmationRecord> {
  const argsHash = canonicalArgsHash(input.args, input.tenantId);
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const conf = await input.client.query<{ id: string }>(
    `INSERT INTO confirmations
       (tenant_id, principal_subject, tool_name, args_hash, args_jsonb, summary_text, estimated_cost_eur, required_approver_roles, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.tenantId,
      input.principalSubject,
      input.toolName,
      argsHash,
      JSON.stringify(input.args),
      input.summaryText,
      centsToEur(input.estimatedCostCents).toString(),
      input.requiredApproverRoles,
      expiresAt,
    ],
  );
  const id = conf.rows[0]!.id;
  await input.client.query(
    `INSERT INTO spend_reservations (tenant_id, confirmation_id, amount_eur, status, window_start)
     VALUES ($1,$2,$3,'pending', date_trunc('month', now()))`,
    [input.tenantId, id, centsToEur(input.estimatedCostCents).toString()],
  );
  return {
    id,
    toolName: input.toolName,
    summaryText: input.summaryText,
    estimatedCostCents: input.estimatedCostCents,
    requiredApproverRoles: input.requiredApproverRoles,
    expiresAt,
  };
}

export interface LoadedConfirmation {
  id: string;
  toolName: string;
  argsHash: Buffer;
  estimatedCostCents: number;
  requiredApproverRoles: Role[];
  expiresAt: Date;
  consumedAt: Date | null;
  argsJsonb: unknown;
}

export async function loadConfirmation(
  client: pg.PoolClient,
  id: string,
): Promise<LoadedConfirmation | null> {
  const r = await client.query<{
    id: string;
    tool_name: string;
    args_hash: Buffer;
    estimated_cost_eur: string;
    required_approver_roles: string[];
    expires_at: Date;
    consumed_at: Date | null;
    args_jsonb: unknown;
  }>(
    `SELECT id, tool_name, args_hash, estimated_cost_eur, required_approver_roles, expires_at, consumed_at, args_jsonb
       FROM confirmations WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    toolName: row.tool_name,
    argsHash: row.args_hash,
    estimatedCostCents: parseEurString(row.estimated_cost_eur),
    requiredApproverRoles: row.required_approver_roles as Role[],
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    argsJsonb: row.args_jsonb,
  };
}

/** Marks the confirmation consumed and the reservation committed (success) or released (failure). */
export async function settleConfirmation(
  client: pg.PoolClient,
  confirmationId: string,
  outcome: 'committed' | 'released',
): Promise<void> {
  if (outcome === 'committed') {
    await client.query('UPDATE confirmations SET consumed_at = now() WHERE id = $1', [
      confirmationId,
    ]);
  }
  await client.query(
    `UPDATE spend_reservations SET status = $2, settled_at = now() WHERE confirmation_id = $1 AND status = 'pending'`,
    [confirmationId, outcome],
  );
}

export { requiredApproverRoles };

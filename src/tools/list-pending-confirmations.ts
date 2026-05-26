import { z } from 'zod';
import type pg from 'pg';
import type { Principal } from '../auth/principal.js';

export function createListPendingConfirmationsTool(deps: { getClient: () => pg.PoolClient }) {
  return {
    name: 'list_pending_confirmations',
    description: 'List pending confirmations awaiting approval that the caller may approve.',
    inputSchema: z.object({}),
    handler: async (_args: unknown, principal: Principal): Promise<unknown> => {
      const client = deps.getClient();
      const r = await client.query<{
        id: string;
        tool_name: string;
        summary_text: string;
        args_jsonb: unknown;
        estimated_cost_eur: string;
        principal_subject: string;
        created_at: Date;
        expires_at: Date;
        required_approver_roles: string[];
      }>(
        `SELECT id, tool_name, summary_text, args_jsonb, estimated_cost_eur, principal_subject, created_at, expires_at, required_approver_roles
           FROM confirmations
          WHERE consumed_at IS NULL AND expires_at > now()`,
      );
      // Filter to confirmations the caller's role may approve.
      const role = (principal as { role?: string }).role ?? '';
      return r.rows
        .filter((row) => row.required_approver_roles.includes(role))
        .map((row) => ({
          confirmation_id: row.id,
          tool_name: row.tool_name,
          summary: row.summary_text,
          args: row.args_jsonb,
          estimated_cost_eur: Number(row.estimated_cost_eur),
          proposer_subject: row.principal_subject,
          created_at: row.created_at,
          expires_at: row.expires_at,
        }));
    },
  };
}

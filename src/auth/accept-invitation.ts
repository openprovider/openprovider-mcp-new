import type pg from 'pg';
import type { Role } from './roles.js';

export type AcceptStatus =
  | 'accepted'
  | 'invalid_token'
  | 'already_accepted'
  | 'expired'
  | 'email_taken';

export type AcceptResult =
  | { status: 'accepted'; tenantId: string; userId: string; role: Role; email: string }
  | { status: Exclude<AcceptStatus, 'accepted'> };

/** Calls the accept_invitation SECURITY DEFINER function. Never throws for expected validation failures. */
export async function acceptInvitation(
  pool: pg.Pool,
  token: string,
  passwordHash: string,
): Promise<AcceptResult> {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE app_role');
    const r = await client.query<{
      status: AcceptStatus;
      tenant_id: string | null;
      user_id: string | null;
      role: string | null;
      email: string | null;
    }>('SELECT * FROM accept_invitation($1, $2)', [token, passwordHash]);
    const row = r.rows[0];
    if (!row) throw new Error('accept_invitation returned no row');
    if (row.status === 'accepted') {
      return { status: 'accepted', tenantId: row.tenant_id!, userId: row.user_id!, role: row.role as Role, email: row.email! };
    }
    return { status: row.status };
  } finally {
    client.release();
  }
}

/** Cross-tenant existence guard for invite creation. */
export async function emailHasUser(pool: pg.Pool, email: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE app_role');
    const r = await client.query<{ email_has_user: boolean }>('SELECT email_has_user($1)', [email]);
    return r.rows[0]!.email_has_user;
  } finally {
    client.release();
  }
}

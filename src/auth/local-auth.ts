import type pg from 'pg';
import type { Role } from './roles.js';

export type SignupResult =
  | { status: 'created'; tenantId: string; userId: string; role: Role }
  | { status: 'email_taken' };

export async function signup(pool: pg.Pool, email: string, passwordHash: string): Promise<SignupResult> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ status: string; tenant_id: string | null; user_id: string | null; role: string | null }>(
      'SELECT * FROM signup_tenant($1, $2)', [email, passwordHash]);
    const row = r.rows[0]!;
    if (row.status === 'created') return { status: 'created', tenantId: row.tenant_id!, userId: row.user_id!, role: row.role as Role };
    return { status: 'email_taken' };
  } finally { c.release(); }
}

export interface FoundUser { userId: string; tenantId: string; role: Role; passwordHash: string | null; }

export async function findUserByEmail(pool: pg.Pool, email: string): Promise<FoundUser | null> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ user_id: string; tenant_id: string; role: string; password_hash: string | null }>(
      'SELECT * FROM find_user_by_email($1)', [email]);
    const row = r.rows[0];
    if (!row) return null;
    return { userId: row.user_id, tenantId: row.tenant_id, role: row.role as Role, passwordHash: row.password_hash };
  } finally { c.release(); }
}

export type ConsumeResetResult = { status: 'ok'; userId: string } | { status: 'invalid_token' | 'expired' | 'already_used' };

export async function consumePasswordReset(pool: pg.Pool, token: string, passwordHash: string): Promise<ConsumeResetResult> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ status: string; user_id: string | null }>(
      'SELECT * FROM consume_password_reset($1, $2)', [token, passwordHash]);
    const row = r.rows[0]!;
    if (row.status === 'ok') return { status: 'ok', userId: row.user_id! };
    return { status: row.status as 'invalid_token' | 'expired' | 'already_used' };
  } finally { c.release(); }
}

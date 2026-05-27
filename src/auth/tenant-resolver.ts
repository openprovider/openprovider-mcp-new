import type pg from 'pg';
import type { Role } from './roles.js';

export type TenantResolution =
  | { status: 'resolved'; tenantId: string; userId: string; role: Role }
  | { status: 'pending_invite' };

export type TenantResolver = (subject: string, email: string) => Promise<TenantResolution>;

export function createTenantResolver(pool: pg.Pool): TenantResolver {
  return async (subject, email) => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE app_role');
      const r = await client.query<{
        status: string;
        tenant_id: string | null;
        user_id: string | null;
        role: string | null;
      }>('SELECT * FROM resolve_or_provision_tenant($1, $2)', [subject, email]);
      const row = r.rows[0];
      if (!row) throw new Error('resolve_or_provision_tenant returned no row');
      if (row.status === 'pending_invite') {
        return { status: 'pending_invite' };
      }
      return {
        status: 'resolved',
        tenantId: row.tenant_id!,
        userId: row.user_id!,
        role: row.role as Role,
      };
    } finally {
      client.release();
    }
  };
}

import type pg from 'pg';

export interface TenantResolution {
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
}

export type TenantResolver = (subject: string, email: string) => Promise<TenantResolution>;

export function createTenantResolver(pool: pg.Pool): TenantResolver {
  return async (subject, email) => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE app_role');
      const r = await client.query<{ tenant_id: string; user_id: string; role: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1, $2)',
        [subject, email],
      );
      const row = r.rows[0];
      if (!row) throw new Error('resolve_or_provision_tenant returned no row');
      return {
        tenantId: row.tenant_id,
        userId: row.user_id,
        role: row.role as TenantResolution['role'],
      };
    } finally {
      client.release();
    }
  };
}

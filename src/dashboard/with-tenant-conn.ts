import type pg from 'pg';

/**
 * Opens a per-request RLS-scoped connection mirroring the dispatchFactory pattern:
 *   BEGIN → SET LOCAL ROLE app_role → set_config(app.current_tenant) → run fn → COMMIT
 * Released and rolled back on error.
 */
export async function withTenantConn<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

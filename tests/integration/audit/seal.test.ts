import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { startFakeGcs, type GcsFixture } from '../_helpers/fake-gcs.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createGcsObjectStore } from '../../../src/audit/object-store.js';
import { sealTenant } from '../../../scripts/audit-seal.js';

const T = '00000000-0000-0000-0000-0000000000f5';

describe('audit:seal → GCS round-trip', () => {
  let pgFixture: PgFixture;
  let gcs: GcsFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    [pgFixture, gcs] = await Promise.all([startPostgres(), startFakeGcs()]);
    const m = await migratedDb(pgFixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]);
    } finally {
      c.release();
    }
    await runAsTenant(pool, T, async (c) => {
      for (const e of ['a', 'b', 'c']) {
        await c.query(
          `INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type, occurred_at)
           VALUES ($1,'system','s',$2, now() - interval '1 day')`,
          [T, e],
        );
      }
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await Promise.all([pgFixture.stop(), gcs.stop()]);
  });

  it('seals rows, uploads gzip, sha256 matches, archive pointer written; re-seal is a no-op', async () => {
    const store = createGcsObjectStore({
      bucket: gcs.bucket,
      apiEndpoint: gcs.endpoint,
      projectId: 'test',
    });
    const before = new Date(); // now → all 3 rows (occurred yesterday) are < before
    const res = await sealTenant(pool, store, T, before);
    expect(res.sealed).toBe(3);
    expect(res.objectUrl).toMatch(/^gs:\/\//);

    // Download + verify sha256 + content.
    const key = `audit/${T}/${before.toISOString().slice(0, 10)}.ndjson.gz`;
    const gz = await store.get(key);

    const arch = await runAsTenant(pool, T, async (c) => {
      const r = await c.query<{ sha256: string }>(
        `SELECT sha256 FROM audit_archives WHERE tenant_id=$1`,
        [T],
      );
      return r.rows[0]!;
    });

    expect(createHash('sha256').update(gz).digest('hex')).toBe(arch.sha256);
    const lines = gunzipSync(gz).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(3);

    // Re-seal: nothing new (watermark advances to cover all 3 rows).
    const res2 = await sealTenant(pool, store, T, before);
    expect(res2.sealed).toBe(0);
  }, 60_000);
});

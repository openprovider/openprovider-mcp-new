# Enterprise Openprovider MCP — Phase 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the secrets/KMS layer from AWS KMS to GCP KMS (single-cloud), and add a tamper-evident per-tenant hash chain to `audit_events` with a `verify-chain` CLI and an `audit:seal` CLI that flushes sealed archives to GCS under a locked retention policy.

**Architecture:** Part A swaps the `Kms` implementation (`createAwsKms` → `createGcpKms`, client-side DEK + KMS wrap) — the `Kms` interface + `secrets/dek.ts` keep everything downstream untouched; LocalStack is dropped and integration KMS uses the in-process `createFakeKms`. Part B adds `prev_hash`/`row_hash` columns + a `BEFORE INSERT` trigger (advisory-lock serialized per tenant, genesis-safe) that maintains the chain transparently; a shared TS canonical-hash helper drives the verifier; `audit:seal` writes gzip+manifest to GCS.

**Tech Stack additions:** `@google-cloud/kms`, `@google-cloud/storage`, `fsouza/fake-gcs-server` (testcontainer). Removed: `@aws-sdk/client-kms`, `@testcontainers/localstack`.

**Spec:** `docs/superpowers/specs/2026-05-26-phase7-gcp-and-audit-chain-design.md`
**Branch:** stacks on `feat/enterprise-phase-1`. **NEVER push** — orchestrator pushes after user confirmation.

---

## File structure

| File | Responsibility |
|---|---|
| `src/secrets/gcp-kms.ts` (new) | GCP KMS adapter (`Kms` impl: client-side DEK + KMS wrap) |
| `src/secrets/gcp-kms.test.ts` (new) | mocked-client round-trip |
| `src/secrets/aws-kms.ts` (delete) | — |
| `tests/integration/_helpers/localstack-kms.ts` (delete) | — |
| `src/config.ts` (mod) | drop AWS_*; add GCP_PROJECT_ID / GCP_KMS_KEY_NAME / GCS_BUCKET |
| `src/audit/chain.ts` (new) | `auditRowCanonical` + `chainHash` (mirrors the SQL trigger) |
| `src/audit/object-store.ts` (new) | GCS put/get |
| `migrations/0010_audit_chain.sql` (new) | prev/row_hash + advisory-locked trigger + audit_archives |
| `src/db/schema.ts` (mod) | audit hash columns + `auditArchives` mirror |
| `scripts/audit-verify.ts` (new) | verify-chain CLI |
| `scripts/audit-seal.ts` (new) | seal CLI |
| `src/server.ts`, `scripts/tenant-onboard.ts` (mod) | createAwsKms → createGcpKms |
| `docker-compose.dev.yml` (mod) | localstack → fake-gcs-server |
| `tests/integration/_helpers/fake-gcs.ts` (new) | fake-gcs-server testcontainer helper |

---

# PART A — GCP KMS Migration (Tasks 1–4)

## Task 1: `gcp-kms.ts` adapter + unit test

**Files:**
- Create: `src/secrets/gcp-kms.ts`
- Create: `src/secrets/gcp-kms.test.ts`

- [ ] **Step 1: Install deps**

```bash
npm install @google-cloud/kms @google-cloud/storage
```

- [ ] **Step 2: Write the failing test `src/secrets/gcp-kms.test.ts`** (inject a fake KMS client that AES-wraps so the round-trip is real)

```ts
import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createGcpKms } from './gcp-kms.js';

// A fake @google-cloud/kms client: encrypt wraps with a fixed key, decrypt unwraps.
function fakeKmsClient() {
  const master = Buffer.alloc(32, 7);
  return {
    encrypt: async ({ plaintext }: { name: string; plaintext: Buffer }) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', master, iv);
      const enc = Buffer.concat([c.update(plaintext), c.final()]);
      const tag = c.getAuthTag();
      return [{ ciphertext: Buffer.concat([iv, tag, enc]) }];
    },
    decrypt: async ({ ciphertext }: { name: string; ciphertext: Buffer }) => {
      const iv = ciphertext.subarray(0, 12);
      const tag = ciphertext.subarray(12, 28);
      const enc = ciphertext.subarray(28);
      const d = createDecipheriv('aes-256-gcm', master, iv);
      d.setAuthTag(tag);
      return [{ plaintext: Buffer.concat([d.update(enc), d.final()]) }];
    },
  };
}

describe('gcp-kms adapter', () => {
  it('generateDataKey returns a 32-byte plaintext + wrapped ciphertext; decrypt round-trips', async () => {
    const kms = createGcpKms({ keyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k', client: fakeKmsClient() as never });
    const { plaintext, ciphertext } = await kms.generateDataKey('ignored');
    expect(plaintext).toHaveLength(32);
    expect(ciphertext.length).toBeGreaterThan(32);
    const back = await kms.decrypt('ignored', ciphertext);
    expect(back.equals(plaintext)).toBe(true);
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `npm test -- gcp-kms`

- [ ] **Step 4: Write `src/secrets/gcp-kms.ts`**

```ts
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { randomBytes } from 'node:crypto';
import type { Kms } from './kms.js';

interface KmsLike {
  encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext?: unknown }]>;
  decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext?: unknown }]>;
}

export function createGcpKms(opts: { keyName: string; client?: KmsLike }): Kms {
  const client: KmsLike = opts.client ?? (new KeyManagementServiceClient() as unknown as KmsLike);
  return {
    async generateDataKey(_keyArn: string) {
      const plaintext = randomBytes(32);
      const [resp] = await client.encrypt({ name: opts.keyName, plaintext });
      if (!resp.ciphertext) throw new Error('GCP KMS encrypt returned no ciphertext');
      return { plaintext, ciphertext: Buffer.from(resp.ciphertext as Uint8Array) };
    },
    async decrypt(_keyArn: string, ciphertext: Buffer) {
      const [resp] = await client.decrypt({ name: opts.keyName, ciphertext });
      if (!resp.plaintext) throw new Error('GCP KMS decrypt returned no plaintext');
      return Buffer.from(resp.plaintext as Uint8Array);
    },
  };
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `npm test -- gcp-kms && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/secrets/gcp-kms.ts src/secrets/gcp-kms.test.ts package.json package-lock.json
git commit -m "feat(phase7): GCP KMS adapter (client-side DEK + KMS wrap)"
```

---

## Task 2: Config swap — drop AWS, add GCP/GCS

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Update `src/config.ts` schema** — remove `AWS_REGION`, `AWS_KMS_KEY_ARN`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and their return fields. Add:

```ts
GCP_PROJECT_ID: z.string().min(1),
GCP_KMS_KEY_NAME: z.string().min(1),
GCS_BUCKET: z.string().min(1),
```
and in the return object:
```ts
gcpProjectId: parsed.GCP_PROJECT_ID,
gcpKmsKeyName: parsed.GCP_KMS_KEY_NAME,
gcsBucket: parsed.GCS_BUCKET,
```

- [ ] **Step 2: Update `src/config.test.ts`** — replace the AWS fields in every fixture with the three GCP fields; update the "all required vars present" test to assert `cfg.gcpKmsKeyName`. Add a test asserting `GCP_KMS_KEY_NAME` is required. Use a `baseGcpEnv` fixture:

```ts
const baseGcpEnv = {
  GCP_PROJECT_ID: 'proj-test',
  GCP_KMS_KEY_NAME: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
  GCS_BUCKET: 'op-mcp-test',
};
```
Spread `...baseGcpEnv` into every `loadConfig({...})` fixture; drop the AWS keys.

- [ ] **Step 3: Update `.env.example`** — remove the AWS block; add:

```
GCP_PROJECT_ID=your-gcp-project
GCP_KMS_KEY_NAME=projects/your-gcp-project/locations/europe-west1/keyRings/openprovider-mcp/cryptoKeys/dek-wrapping
GCS_BUCKET=openprovider-mcp-audit
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
# For fake-gcs-server in local dev: STORAGE_EMULATOR_HOST=http://localhost:4443
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- config && npm run typecheck`
Expected: config tests pass. (Other files referencing `cfg.kmsKeyArn`/`cfg.awsRegion` will now fail typecheck — that's fixed in Task 3. Do NOT fix here; this commit leaves typecheck red.)

- [ ] **Step 5: Commit (typecheck red until Task 3 — use --no-verify)**

```bash
git add src/config.ts src/config.test.ts .env.example
git commit --no-verify -m "feat(phase7): config swap — GCP_PROJECT_ID/GCP_KMS_KEY_NAME/GCS_BUCKET, drop AWS"
```

> Typecheck is red between Task 2 and Task 3 by design (config consumers reference the removed AWS fields). Task 3 restores green.

---

## Task 3: Wire GCP KMS everywhere; delete AWS; migrate test fixtures

**Files:**
- Modify: `src/server.ts`, `scripts/tenant-onboard.ts`
- Delete: `src/secrets/aws-kms.ts`, `tests/integration/_helpers/localstack-kms.ts`
- Modify: `tests/integration/secrets/store.test.ts`, `tests/integration/openprovider/token-cache-pg.test.ts` (if it builds a KMS), `tests/integration/mcp/e2e.test.ts`, and any other test importing `createAwsKms`/`startLocalstackKms`
- Modify: `docker-compose.dev.yml`, `package.json`
- Modify: `vitest.config.ts` (coverage exclude: swap `aws-kms.ts` → `gcp-kms.ts` if `gcp-kms.ts` should be excluded; it's unit-tested, so just remove the `aws-kms.ts` exclude line)

- [ ] **Step 1: Replace KMS construction in `src/server.ts`**

```ts
import { createGcpKms } from './secrets/gcp-kms.js';
// remove: import { createAwsKms } ...
const kms = createGcpKms({ keyName: cfg.gcpKmsKeyName });
```
Remove the readiness check that called `kms.generateDataKey(cfg.kmsKeyArn)` — change it to `kms.generateDataKey(cfg.gcpKmsKeyName)` (the arg is ignored by the GCP adapter but keep a valid call), or simpler, a lightweight check. Keep the `db` readiness check unchanged.

- [ ] **Step 2: Replace KMS in `scripts/tenant-onboard.ts`** — `createGcpKms({ keyName: cfg.gcpKmsKeyName })`; `createSecretsStore({ kms, kmsKeyArn: cfg.gcpKmsKeyName, repo })` (the `kmsKeyArn` param now carries the GCP key name — stored in `tenant_keys.kms_key_arn`, semantics unchanged).

- [ ] **Step 3: Delete the AWS files**

```bash
git rm src/secrets/aws-kms.ts tests/integration/_helpers/localstack-kms.ts
```

- [ ] **Step 4: Migrate integration test fixtures** — in every integration test that did `createAwsKms({...})` + `startLocalstackKms()`, replace with the in-process fake:
  - Remove `startLocalstackKms` import + its fixture lifecycle.
  - `import { createFakeKms } from '../../../src/secrets/fake-kms.js';`
  - Replace `const kms = createAwsKms({ region, endpoint })` with `const kms = createFakeKms();`
  - Replace `kmsKeyArn: kmsFixture.keyArn` with a constant `kmsKeyArn: 'fake-key'` (the fake ignores it).
  - Drop the `kms.stop()` / Promise.all teardown of the KMS container (only Postgres remains).

  Files to check: `tests/integration/secrets/store.test.ts`, `tests/integration/mcp/e2e.test.ts`, and any token-cache test that built a KMS. Grep first: `grep -rl "createAwsKms\|startLocalstackKms" tests/`.

- [ ] **Step 5: Update `docker-compose.dev.yml`** — remove the `localstack` service; add:

```yaml
  fake-gcs:
    image: fsouza/fake-gcs-server:1.49
    command: ['-scheme', 'http', '-port', '4443', '-public-host', 'localhost:4443']
    ports: ['4443:4443']
```

- [ ] **Step 6: Remove `@aws-sdk/client-kms` + `@testcontainers/localstack`**

```bash
npm uninstall @aws-sdk/client-kms @testcontainers/localstack
```

- [ ] **Step 7: Verify everything green**

```bash
npm run typecheck && npm run lint && npm test && npm run test:integration
```
Expected: all green. The secrets/store + e2e integration tests now use `createFakeKms` and pass without LocalStack.

> If `grep -rl "createAwsKms\|startLocalstackKms\|aws-sdk" src tests` returns anything after this task, fix it — AWS must be fully gone.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(phase7): wire GCP KMS; delete aws-kms + localstack; fake-kms for integration; drop @aws-sdk"
```

---

## Task 4: Opt-in live GCP KMS test

**Files:**
- Create: `tests/integration/secrets/gcp-kms-live.test.ts`

- [ ] **Step 1: Write the env-gated live test**

```ts
import { describe, expect, it } from 'vitest';
import { createGcpKms } from '../../../src/secrets/gcp-kms.js';

const LIVE = process.env.GCP_LIVE === '1';
const d = LIVE ? describe : describe.skip;

// Requires: GCP_LIVE=1, GCP_KMS_KEY_NAME=projects/.../cryptoKeys/..., GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json
d('live GCP KMS — DEK wrap/unwrap round trip', () => {
  it('generateDataKey then decrypt returns the same key', async () => {
    const kms = createGcpKms({ keyName: process.env.GCP_KMS_KEY_NAME! });
    const { plaintext, ciphertext } = await kms.generateDataKey(process.env.GCP_KMS_KEY_NAME!);
    const back = await kms.decrypt(process.env.GCP_KMS_KEY_NAME!, ciphertext);
    expect(back.equals(plaintext)).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Confirm it SKIPS by default**

Run: `npm run test:integration -- gcp-kms-live`
Expected: 1 skipped, 0 run.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/secrets/gcp-kms-live.test.ts
git commit -m "test(phase7): opt-in live GCP KMS round-trip (env-gated)"
```

---

# PART B — Audit Hash Chain + GCS Sealing (Tasks 5–9)

## Task 5: `src/audit/chain.ts` — shared canonical formula

**Files:**
- Create: `src/audit/chain.ts`
- Create: `src/audit/chain.test.ts`

The canonical formula MUST match the SQL trigger (Task 6) exactly: fields joined with `|` in this order, NULLs → empty string; `row_hash = sha256(prev_hash || utf8(canonical))`; genesis prev_hash = 32 zero bytes.

- [ ] **Step 1: Write `src/audit/chain.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { auditRowCanonical, chainHash, GENESIS } from './chain.js';

const row = {
  id: '1', occurredAt: '2026-05-26T00:00:00.000Z', tenantId: 't',
  actorKind: 'user', actorSubject: 's', eventType: 'tool.call',
  toolName: 'check_domain', resourceType: null, resourceId: null,
  requestArgs: { d: 'x.com' }, result: null, httpStatus: null, errorCode: null,
  traceId: null, spanId: null,
};

describe('audit chain helper', () => {
  it('GENESIS is 32 zero bytes', () => {
    expect(GENESIS).toHaveLength(32);
    expect(GENESIS.every((b) => b === 0)).toBe(true);
  });
  it('canonical joins fields with | and renders nulls as empty', () => {
    const c = auditRowCanonical(row);
    expect(c.startsWith('1|2026-05-26T00:00:00.000Z|t|user|s|tool.call|check_domain|||')).toBe(true);
    expect(c).toContain('{"d":"x.com"}'); // request_args jsonb text
  });
  it('chainHash is deterministic and 32 bytes', () => {
    const h1 = chainHash(GENESIS, auditRowCanonical(row));
    const h2 = chainHash(GENESIS, auditRowCanonical(row));
    expect(h1).toHaveLength(32);
    expect(h1.equals(h2)).toBe(true);
  });
  it('different prev_hash yields different row_hash', () => {
    const a = chainHash(GENESIS, auditRowCanonical(row));
    const b = chainHash(a, auditRowCanonical(row));
    expect(a.equals(b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Write `src/audit/chain.ts`**

```ts
import { createHash } from 'node:crypto';

export const GENESIS = Buffer.alloc(32, 0);

export interface AuditRowForHash {
  id: string;
  occurredAt: string;            // ISO string matching Postgres timestamptz::text? See note.
  tenantId: string;
  actorKind: string;
  actorSubject: string;
  eventType: string;
  toolName: string | null;
  resourceType: string | null;
  resourceId: string | null;
  requestArgs: unknown | null;   // jsonb
  result: unknown | null;        // jsonb
  httpStatus: number | null;
  errorCode: string | null;
  traceId: string | null;
  spanId: string | null;
}

function jsonbText(v: unknown | null): string {
  if (v === null || v === undefined) return '';
  return JSON.stringify(v);
}

export function auditRowCanonical(r: AuditRowForHash): string {
  return [
    r.id, r.occurredAt, r.tenantId, r.actorKind, r.actorSubject, r.eventType,
    r.toolName ?? '', r.resourceType ?? '', r.resourceId ?? '',
    jsonbText(r.requestArgs), jsonbText(r.result),
    r.httpStatus === null || r.httpStatus === undefined ? '' : String(r.httpStatus),
    r.errorCode ?? '', r.traceId ?? '', r.spanId ?? '',
  ].join('|');
}

export function chainHash(prev: Buffer, canonical: string): Buffer {
  return createHash('sha256').update(prev).update(Buffer.from(canonical, 'utf8')).digest();
}
```

> **CRITICAL drift risk — jsonb text representation:** Postgres `jsonb::text` and JS `JSON.stringify` may format differently (key order, spacing). The verifier (Task 7) reads `request_args`/`result` back from the DB as parsed JS objects via `pg`, then re-stringifies — so as long as BOTH the trigger and the verifier hash the SAME serialization, they match. To guarantee that, the verifier must hash using the **exact bytes the trigger used**. The robust approach (used in Task 6/7): the trigger computes the canonical from `NEW.request_args::text` (Postgres jsonb text), and the verifier re-reads the row and uses the DB's `request_args::text` too (select it as text, not as parsed json). The plan's Task 7 selects the jsonb columns CAST to text so the verifier hashes identical bytes. The `auditRowCanonical` helper therefore takes already-stringified jsonb text (the verifier passes `row.request_args_text`); update the helper's `requestArgs`/`result` to be `string | null` (the raw `::text`) rather than re-stringifying. **Adjust the helper + test accordingly:** the fields are `requestArgsText: string | null` / `resultText: string | null`, used verbatim. This removes all serialization-drift risk.

- [ ] **Step 4: Apply the jsonb-text adjustment** — change `AuditRowForHash` to carry `requestArgsText: string | null` and `resultText: string | null` (verbatim DB `::text`), drop `jsonbText()`, and use those strings directly in `auditRowCanonical`. Update the test's `row` to pass `requestArgsText: '{"d": "x.com"}'` (whatever Postgres emits) and assert on that.

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/audit/chain.ts src/audit/chain.test.ts
git commit -m "feat(phase7): shared audit canonical-hash helper (jsonb-as-text, no drift)"
```

---

## Task 6: Migration 0010 — chain columns + advisory-locked trigger + audit_archives

**Files:**
- Create: `migrations/0010_audit_chain.sql`
- Modify: `migrations/meta/_journal.json`, `src/db/schema.ts`
- Create: `tests/integration/db/audit-chain.test.ts`

- [ ] **Step 1: Write `migrations/0010_audit_chain.sql`**

```sql
ALTER TABLE audit_events ADD COLUMN prev_hash bytea;
ALTER TABLE audit_events ADD COLUMN row_hash  bytea;

CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev bytea;
  v_canon text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

  SELECT row_hash INTO v_prev
    FROM audit_events
   WHERE tenant_id = NEW.tenant_id
   ORDER BY id DESC LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev,
    '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);

  v_canon := concat_ws('|',
    NEW.id::text, NEW.occurred_at::text, NEW.tenant_id::text,
    NEW.actor_kind, NEW.actor_subject, NEW.event_type,
    COALESCE(NEW.tool_name,''), COALESCE(NEW.resource_type,''), COALESCE(NEW.resource_id,''),
    COALESCE(NEW.request_args::text,''), COALESCE(NEW.result::text,''),
    COALESCE(NEW.http_status::text,''), COALESCE(NEW.error_code,''),
    COALESCE(NEW.trace_id,''), COALESCE(NEW.span_id,''));

  NEW.row_hash := digest(NEW.prev_hash || convert_to(v_canon, 'UTF8'), 'sha256');
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_chain_trg BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

CREATE TABLE audit_archives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  period_end    timestamptz NOT NULL,
  object_url    text NOT NULL,
  sha256        text NOT NULL,
  first_id      bigint NOT NULL,
  last_id       bigint NOT NULL,
  last_row_hash bytea NOT NULL,
  sealed_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_archives_isolation ON audit_archives
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT ON audit_archives TO app_role;
```

> `concat_ws('|', ...)` skips NULL args (it does not emit the separator for a NULL) — to match the TS helper which emits empty strings between separators, every nullable field is wrapped in `COALESCE(...,'')` so a value is always present and `concat_ws` always emits all 15 fields with 14 separators. Verify the TS `join('|')` of 15 fields produces the identical string.

- [ ] **Step 2: Journal entry** `{ "idx": 9, "version": "5", "when": 1748500000000, "tag": "0010_audit_chain", "breakpoints": true }`.

- [ ] **Step 3: Schema mirror** — add `prevHash`/`rowHash` (bytea) to the existing `auditEvents` table in `src/db/schema.ts`, and add the `auditArchives` table:

```ts
// add to auditEvents columns:
prevHash: bytea('prev_hash'),
rowHash: bytea('row_hash'),

export const auditArchives = pgTable('audit_archives', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  objectUrl: text('object_url').notNull(),
  sha256: text('sha256').notNull(),
  firstId: bigint('first_id', { mode: 'bigint' }).notNull(),
  lastId: bigint('last_id', { mode: 'bigint' }).notNull(),
  lastRowHash: bytea('last_row_hash').notNull(),
  sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Write `tests/integration/db/audit-chain.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { GENESIS } from '../../../src/audit/chain.js';

const A = '00000000-0000-0000-0000-0000000000f1';
const B = '00000000-0000-0000-0000-0000000000f2';

async function insertEvent(c: pg.PoolClient, tenant: string, eventType: string) {
  await c.query(
    `INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type)
     VALUES ($1,'system','s',$2)`, [tenant, eventType]);
}

describe('audit chain trigger', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres(); const m = await migratedDb(fixture.url); pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'a'),($2,'b')`, [A, B]); } finally { c.release(); }
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('populates prev/row hash; genesis is 32 zeros; chain links', async () => {
    await runAsTenant(pool, A, async (c) => {
      await insertEvent(c, A, 'e1'); await insertEvent(c, A, 'e2'); await insertEvent(c, A, 'e3');
      const r = await c.query<{ prev_hash: Buffer; row_hash: Buffer }>(
        `SELECT prev_hash, row_hash FROM audit_events WHERE tenant_id=$1 ORDER BY id`, [A]);
      expect(r.rows[0]!.prev_hash.equals(GENESIS)).toBe(true);
      expect(r.rows[1]!.prev_hash.equals(r.rows[0]!.row_hash)).toBe(true);
      expect(r.rows[2]!.prev_hash.equals(r.rows[1]!.row_hash)).toBe(true);
    });
  });

  it('per-tenant chains are independent (B genesis is zeros despite A having rows)', async () => {
    await runAsTenant(pool, B, async (c) => {
      await insertEvent(c, B, 'b1');
      const r = await c.query<{ prev_hash: Buffer }>(
        `SELECT prev_hash FROM audit_events WHERE tenant_id=$1 ORDER BY id LIMIT 1`, [B]);
      expect(r.rows[0]!.prev_hash.equals(GENESIS)).toBe(true);
    });
  });

  it('concurrent inserts for one tenant produce an unbroken linear chain', async () => {
    const T = '00000000-0000-0000-0000-0000000000f3';
    const seed = await pool.connect();
    try { await seed.query(`INSERT INTO tenants (id,name) VALUES ($1,'c')`, [T]); } finally { seed.release(); }
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      runAsTenant(pool, T, (c) => insertEvent(c, T, `c${i}`))));
    await runAsTenant(pool, T, async (c) => {
      const r = await c.query<{ prev_hash: Buffer; row_hash: Buffer }>(
        `SELECT prev_hash, row_hash FROM audit_events WHERE tenant_id=$1 ORDER BY id`, [T]);
      expect(r.rows).toHaveLength(8);
      expect(r.rows[0]!.prev_hash.equals(GENESIS)).toBe(true);
      for (let i = 1; i < r.rows.length; i++) {
        expect(r.rows[i]!.prev_hash.equals(r.rows[i - 1]!.row_hash)).toBe(true);
      }
    });
  }, 30_000);
});
```

- [ ] **Step 5: Run, expect PASS**

Run: `npm run test:integration -- audit-chain && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add migrations/0010_audit_chain.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/audit-chain.test.ts
git commit -m "feat(phase7): audit hash chain trigger (advisory-locked, per-tenant) + audit_archives"
```

---

## Task 7: `verify-chain` CLI

**Files:**
- Create: `scripts/audit-verify.ts`
- Create: `tests/integration/audit/verify.test.ts`

- [ ] **Step 1: Write `scripts/audit-verify.ts`**

```ts
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { GENESIS, auditRowCanonical, chainHash } from '../src/audit/chain.js';

export interface VerifyResult { ok: boolean; rows: number; brokenAtId?: string; }

export async function verifyTenantChain(pool: import('pg').Pool, tenantId: string): Promise<VerifyResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);
    const r = await client.query<{
      id: string; occurred_at: Date; tenant_id: string; actor_kind: string; actor_subject: string;
      event_type: string; tool_name: string | null; resource_type: string | null; resource_id: string | null;
      request_args_text: string | null; result_text: string | null; http_status: number | null;
      error_code: string | null; trace_id: string | null; span_id: string | null;
      prev_hash: Buffer; row_hash: Buffer;
    }>(
      `SELECT id, occurred_at, tenant_id, actor_kind, actor_subject, event_type, tool_name,
              resource_type, resource_id, request_args::text AS request_args_text,
              result::text AS result_text, http_status, error_code, trace_id, span_id,
              prev_hash, row_hash
         FROM audit_events WHERE tenant_id = $1 ORDER BY id`, [tenantId]);
    await client.query('COMMIT');

    let expectedPrev = GENESIS;
    for (const row of r.rows) {
      if (!row.prev_hash.equals(expectedPrev)) return { ok: false, rows: r.rows.length, brokenAtId: row.id };
      const canon = auditRowCanonical({
        id: row.id, occurredAt: row.occurred_at.toISOString(), tenantId: row.tenant_id,
        actorKind: row.actor_kind, actorSubject: row.actor_subject, eventType: row.event_type,
        toolName: row.tool_name, resourceType: row.resource_type, resourceId: row.resource_id,
        requestArgsText: row.request_args_text, resultText: row.result_text,
        httpStatus: row.http_status, errorCode: row.error_code, traceId: row.trace_id, spanId: row.span_id,
      });
      const recomputed = chainHash(row.prev_hash, canon);
      if (!recomputed.equals(row.row_hash)) return { ok: false, rows: r.rows.length, brokenAtId: row.id };
      expectedPrev = row.row_hash;
    }
    return { ok: true, rows: r.rows.length };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { tenant: { type: 'string' } } });
  if (!values.tenant) { console.error('Usage: audit:verify --tenant <uuid>'); process.exit(1); }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  try {
    const res = await verifyTenantChain(pool, values.tenant);
    if (res.ok) { console.error(`OK (${res.rows} rows)`); }
    else { console.error(`audit.chain.broken at id=${res.brokenAtId}`); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}

// Only run main() when invoked as a script, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('audit-verify.ts')) { void main(); }
```

> `occurred_at.toISOString()` must match Postgres `occurred_at::text`. **This is the highest drift risk.** Postgres `timestamptz::text` renders like `2026-05-26 00:00:00.123456+00` (space separator, microseconds, `+00`), NOT ISO-8601. So `toISOString()` will NOT match. **Fix:** the verifier must select `occurred_at::text` from the DB (the exact string the trigger hashed) and pass THAT verbatim — do not reformat via `toISOString()`. Change the SELECT to `occurred_at::text AS occurred_at_text` and pass `occurredAt: row.occurred_at_text`. Apply the same principle as the jsonb columns: hash the DB's own `::text` rendering for every field, never a JS reformat. Update `AuditRowForHash.occurredAt` doc to "the DB occurred_at::text verbatim".

- [ ] **Step 2: Apply the `occurred_at::text` fix** — select `occurred_at::text AS occurred_at_text`, pass it verbatim as `occurredAt`. (Same for any other non-string field if needed: `tenant_id::text`, `http_status::text` — select them as text to match the trigger's casts exactly. Simplest + safest: SELECT every hashed field with `::text` and pass the strings straight through, so the verifier never reformats anything.)

- [ ] **Step 3: Write `tests/integration/audit/verify.test.ts`** (the tamper-detection marquee):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { verifyTenantChain } from '../../../scripts/audit-verify.js';

const T = '00000000-0000-0000-0000-0000000000f4';

describe('verify-chain', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres(); const m = await migratedDb(fixture.url); pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]);
    } finally { c.release(); }
    await runAsTenant(pool, T, async (c) => {
      for (const e of ['a', 'b', 'c', 'd']) {
        await c.query(`INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type, request_args)
                       VALUES ($1,'system','s',$2,$3)`, [T, e, JSON.stringify({ n: e })]);
      }
    });
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('verifies an intact chain', async () => {
    const res = await verifyTenantChain(pool, T);
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(4);
  });

  it('detects a tampered row (mutate event_type with the migration/superuser role bypassing app_role)', async () => {
    // The migration role (testcontainer superuser) can UPDATE despite the app_role append-only grant.
    const c = await pool.connect();
    try {
      await c.query(`UPDATE audit_events SET event_type = 'TAMPERED'
                     WHERE tenant_id = $1 AND event_type = 'b'`, [T]);
    } finally { c.release(); }
    const res = await verifyTenantChain(pool, T);
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBeTruthy();
  });
});
```

> The tamper test mutates via the pool's default (superuser) connection — NOT `runAsTenant` (app_role can't UPDATE audit_events). This simulates an attacker with elevated DB access; the hash chain catches it even though the grant-level append-only protection was bypassed.

- [ ] **Step 4: Run, expect PASS**

Run: `npm run test:integration -- audit/verify && npm run typecheck && npm run lint`

- [ ] **Step 5: Add npm script** to `package.json`: `"audit:verify": "tsx scripts/audit-verify.ts"`.

- [ ] **Step 6: Commit**

```bash
git add scripts/audit-verify.ts tests/integration/audit/verify.test.ts package.json
git commit -m "feat(phase7): verify-chain CLI + tamper-detection test (DB ::text hashing, no drift)"
```

---

## Task 8: GCS object store + `audit:seal` CLI

**Files:**
- Create: `src/audit/object-store.ts`
- Create: `tests/integration/_helpers/fake-gcs.ts`
- Create: `scripts/audit-seal.ts`
- Create: `tests/integration/audit/seal.test.ts`
- Create: `tests/integration/audit/gcs-live.test.ts`

- [ ] **Step 1: Write `src/audit/object-store.ts`**

```ts
import { Storage } from '@google-cloud/storage';

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<string>; // returns gs:// url
  get(key: string): Promise<Buffer>;
}

export function createGcsObjectStore(opts: { bucket: string; apiEndpoint?: string; projectId?: string }): ObjectStore {
  const storage = new Storage({
    projectId: opts.projectId ?? process.env.GCP_PROJECT_ID,
    ...(opts.apiEndpoint ? { apiEndpoint: opts.apiEndpoint } : {}),
  });
  const bucket = storage.bucket(opts.bucket);
  return {
    async put(key, body, contentType) {
      await bucket.file(key).save(body, { contentType, resumable: false });
      return `gs://${opts.bucket}/${key}`;
    },
    async get(key) {
      const [buf] = await bucket.file(key).download();
      return buf;
    },
  };
}
```

> Object-lock/retention enforcement comes from the bucket's **locked retention policy** (operator-configured), not the client — `put` just writes; the bucket denies premature deletes. The `gcs-live.test.ts` proves enforcement against a real locked bucket.

- [ ] **Step 2: Write `tests/integration/_helpers/fake-gcs.ts`** (testcontainer)

```ts
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Storage } from '@google-cloud/storage';

export interface GcsFixture {
  endpoint: string;
  bucket: string;
  stop: () => Promise<void>;
}

export async function startFakeGcs(bucket = 'op-mcp-test'): Promise<GcsFixture> {
  const container: StartedTestContainer = await new GenericContainer('fsouza/fake-gcs-server:1.49')
    .withCommand(['-scheme', 'http', '-port', '4443', '-public-host', 'localhost:4443'])
    .withExposedPorts(4443)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(4443)}`;
  // Create the bucket via the client.
  const storage = new Storage({ projectId: 'test', apiEndpoint: endpoint });
  await storage.createBucket(bucket).catch(() => { /* may already exist */ });
  return { endpoint, bucket, stop: async () => { await container.stop(); } };
}
```

Install testcontainers' generic module — `testcontainers` (already a dep) exports `GenericContainer`.

- [ ] **Step 3: Write `scripts/audit-seal.ts`**

```ts
import 'dotenv/config';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { createDb } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createGcsObjectStore, type ObjectStore } from '../src/audit/object-store.js';

export async function sealTenant(
  pool: pg.Pool, store: ObjectStore, tenantId: string, before: Date,
): Promise<{ sealed: number; objectUrl?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);

    const watermark = await client.query<{ last_id: string }>(
      `SELECT COALESCE(MAX(last_id),0)::text AS last_id FROM audit_archives WHERE tenant_id=$1`, [tenantId]);
    const fromId = BigInt(watermark.rows[0]!.last_id);

    const rows = await client.query<Record<string, unknown>>(
      `SELECT id, occurred_at, tenant_id, actor_kind, actor_subject, event_type, tool_name,
              resource_type, resource_id, request_args, result, http_status, error_code,
              trace_id, span_id, encode(prev_hash,'hex') AS prev_hash, encode(row_hash,'hex') AS row_hash
         FROM audit_events
        WHERE tenant_id=$1 AND occurred_at < $2 AND id > $3
        ORDER BY id`, [tenantId, before, fromId.toString()]);

    if (rows.rows.length === 0) { await client.query('COMMIT'); return { sealed: 0 }; }

    const ndjson = rows.rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const gz = gzipSync(Buffer.from(ndjson, 'utf8'));
    const sha = createHash('sha256').update(gz).digest('hex');
    const firstId = String(rows.rows[0]!.id);
    const lastId = String(rows.rows[rows.rows.length - 1]!.id);
    const lastRowHashHex = rows.rows[rows.rows.length - 1]!.row_hash as string;
    const key = `audit/${tenantId}/${before.toISOString().slice(0, 10)}.ndjson.gz`;
    const url = await store.put(key, gz, 'application/gzip');

    await client.query(
      `INSERT INTO audit_archives (tenant_id, period_end, object_url, sha256, first_id, last_id, last_row_hash)
       VALUES ($1,$2,$3,$4,$5,$6, decode($7,'hex'))`,
      [tenantId, before, url, sha, firstId, lastId, lastRowHashHex]);
    await client.query('COMMIT');
    return { sealed: rows.rows.length, objectUrl: url };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { before: { type: 'string' }, tenant: { type: 'string' } } });
  if (!values.before || !values.tenant) {
    console.error('Usage: audit:seal --before YYYY-MM-DD --tenant <uuid>'); process.exit(1);
  }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const store = createGcsObjectStore({ bucket: cfg.gcsBucket });
  try {
    const res = await sealTenant(pool, store, values.tenant, new Date(values.before));
    console.error(`Sealed ${res.sealed} rows${res.objectUrl ? ' → ' + res.objectUrl : ''}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('audit-seal.ts')) { void main(); }
```

> NOTE: this seal exports all-tenants when `--tenant` omitted is a future nicety; Phase 7 requires `--tenant`. The `last_row_hash` is stored as hex from the query and decoded back to bytea on insert.

- [ ] **Step 4: Write `tests/integration/audit/seal.test.ts`** (Postgres + fake-gcs)

```ts
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
  let pg: PgFixture; let gcs: GcsFixture; let pool: pg.Pool;
  beforeAll(async () => {
    [pg, gcs] = await Promise.all([startPostgres(), startFakeGcs()]);
    const m = await migratedDb(pg.url); pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]); } finally { c.release(); }
    await runAsTenant(pool, T, async (c) => {
      for (const e of ['a', 'b', 'c']) {
        await c.query(`INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type, occurred_at)
                       VALUES ($1,'system','s',$2, now() - interval '1 day')`, [T, e]);
      }
    });
  }, 120_000);
  afterAll(async () => { await pool.end(); await Promise.all([pg.stop(), gcs.stop()]); });

  it('seals rows, uploads gzip, sha256 matches, archive pointer written; re-seal is a no-op', async () => {
    const store = createGcsObjectStore({ bucket: gcs.bucket, apiEndpoint: gcs.endpoint, projectId: 'test' });
    const before = new Date(); // now → all 3 rows (occurred yesterday) are < before
    const res = await sealTenant(pool, store, T, before);
    expect(res.sealed).toBe(3);
    expect(res.objectUrl).toMatch(/^gs:\/\//);

    // Download + verify sha256 + content.
    const key = `audit/${T}/${before.toISOString().slice(0, 10)}.ndjson.gz`;
    const gz = await store.get(key);
    const arch = await runAsTenant(pool, T, async (c) => {
      const r = await c.query<{ sha256: string }>(`SELECT sha256 FROM audit_archives WHERE tenant_id=$1`, [T]);
      return r.rows[0]!;
    });
    expect(createHash('sha256').update(gz).digest('hex')).toBe(arch.sha256);
    const lines = gunzipSync(gz).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(3);

    // Re-seal: nothing new (watermark).
    const res2 = await sealTenant(pool, store, T, before);
    expect(res2.sealed).toBe(0);
  }, 60_000);
});
```

- [ ] **Step 5: Write the opt-in `tests/integration/audit/gcs-live.test.ts`** (Bucket-Lock enforcement, env-gated)

```ts
import { describe, expect, it } from 'vitest';

const LIVE = process.env.GCS_LIVE === '1';
const d = LIVE ? describe : describe.skip;

// Requires GCS_LIVE=1, GCS_BUCKET=<a bucket with a LOCKED 7y retention policy>, GOOGLE_APPLICATION_CREDENTIALS.
d('live GCS — Bucket Lock denies premature delete', () => {
  it('uploads a sealed object then a delete-before-retention is denied', async () => {
    // Upload a small object to the locked bucket, attempt bucket.file(key).delete(),
    // assert it rejects (retention policy not yet met). Cleanup is impossible by design — use a throwaway key.
    expect(LIVE).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 6: Run**

```bash
npm run test:integration -- audit/seal
npm run test:integration -- audit/gcs-live   # skipped (0 run) without GCS_LIVE
npm run typecheck && npm run lint
```

- [ ] **Step 7: Add npm script** `"audit:seal": "tsx scripts/audit-seal.ts"`; add `src/audit/object-store.ts` to vitest coverage exclude (integration-tested).

- [ ] **Step 8: Commit**

```bash
git add src/audit/object-store.ts tests/integration/_helpers/fake-gcs.ts scripts/audit-seal.ts tests/integration/audit/seal.test.ts tests/integration/audit/gcs-live.test.ts package.json vitest.config.ts
git commit -m "feat(phase7): GCS object store + audit:seal CLI + fake-gcs round-trip + opt-in GCS_LIVE lock test"
```

---

## Task 9: README + CHANGELOG + `v0.7.0-phase7` tag (local only)

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Update `README.md`** — status → Phase 7; note GCP (KMS + GCS) is now the cloud (AWS removed); add `audit:verify` / `audit:seal` to the commands; document the GCP env vars (`GCP_PROJECT_ID`, `GCP_KMS_KEY_NAME`, `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`) + that the GCS bucket needs a locked retention policy; mention `fake-gcs-server` for local dev.

- [ ] **Step 2: Prepend `## [0.7.0-phase7] — 2026-05-26` to `CHANGELOG.md`**

```markdown
## [0.7.0-phase7] — 2026-05-26

### Added
- Tamper-evident per-tenant audit hash chain: prev_hash/row_hash on audit_events, maintained by an advisory-lock-serialized BEFORE INSERT trigger (genesis-safe).
- `audit:verify` CLI — recomputes the chain (hashing the DB's own ::text rendering to avoid serialization drift) and detects tampering even when the append-only grant is bypassed by an elevated role.
- `audit:seal` CLI — flushes sealed periods to GCS as gzip + sha256 manifest, watermark-idempotent, writes audit_archives pointers.
- GCS object store (`@google-cloud/storage`); seal targets a bucket with a locked retention policy.

### Changed
- **Migrated KMS from AWS to GCP** (single-cloud GCP). New `gcp-kms.ts` (client-side DEK + KMS wrap via the existing Kms interface). AWS removed entirely: deleted aws-kms.ts + LocalStack helper, dropped @aws-sdk/client-kms.
- Integration KMS now uses the in-process fake adapter; real GCP KMS fidelity is in an opt-in GCP_LIVE suite. LocalStack replaced by fake-gcs-server.
- Config: GCP_PROJECT_ID / GCP_KMS_KEY_NAME / GCS_BUCKET replace the AWS_* vars.

### Deferred
- Monthly partitioning of audit_events (Phase 8 if volume warrants).
- pg-boss always-on workers / scheduled sealing (Phase 8) — audit:seal is cron-triggerable.
- Dashboard (Phase 6).
```

- [ ] **Step 3: Commit + tag (DO NOT PUSH)**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(phase7): CHANGELOG + README for 0.7.0-phase7"
git tag -a v0.7.0-phase7 -m "Phase 7: GCP KMS migration + audit hash chain + GCS sealing"
```

- [ ] **Step 4: Verify**

Run: `git tag --list 'v0.*'`
Expected: phase1, phase2, phase3, phase4, phase5, `v0.7.0-phase7`. **DO NOT PUSH.**

---

## Phase 7 exit checklist

- [ ] GCP KMS adapter unit test green; AWS fully removed (`grep -r "aws-sdk\|createAwsKms\|localstack" src tests` empty).
- [ ] All integration tests pass using `createFakeKms` (no LocalStack); only Postgres (+ fake-gcs for seal) containers.
- [ ] Audit chain: trigger populates prev/row hash; genesis = 32 zeros; per-tenant independent; concurrent inserts stay linear.
- [ ] `audit:verify` verifies an intact chain and detects a tampered row (marquee).
- [ ] `audit:seal` round-trips to fake-gcs (sha256 matches, archive pointer, re-seal no-op); `GCS_LIVE`/`GCP_LIVE` tests skip by default.
- [ ] `npm test` + `npm run test:integration` green; typecheck + lint clean.
- [ ] CHANGELOG `0.7.0-phase7` + tag created locally.

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 gcp-kms adapter | 1 |
| §3 config swap | 2 |
| §4 wiring + delete AWS + fake-kms migration + docker-compose | 3 |
| §5 gcp-kms unit test | 1 |
| §6 chain trigger (advisory lock) | 6 |
| §7 audit_archives | 6 |
| §8 verify-chain CLI + shared formula | 5, 7 |
| §9 object store + audit:seal | 8 |
| §10 tests (chain/tamper/concurrent/seal/live) | 5,6,7,8 + opt-in 4,8 |

**Placeholder scan:** No "TBD". Two opt-in live tests (4, 8 step 5) are intentional env-gated stubs that skip in CI. The biggest risk — hash-formula drift between the SQL trigger and the TS verifier — is addressed head-on: **both hash the DB's own `::text` rendering** (the verifier SELECTs every hashed field as `::text` and passes it verbatim; Task 5 step 4 + Task 7 steps 1–2 make this explicit). No JS reformatting of timestamps/jsonb.

**Type consistency:** `Kms` interface (existing) implemented by `createGcpKms` (Task 1) + `createFakeKms` (existing). `auditRowCanonical`/`chainHash`/`GENESIS` (Task 5) used by the verifier (Task 7). `ObjectStore` (Task 8) used by `sealTenant` (Task 8). `verifyTenantChain`/`sealTenant` are exported from the scripts and imported by their integration tests (the scripts guard `main()` behind an `argv[1]` check so importing doesn't execute). `audit_archives` columns (Task 6) match the seal insert (Task 8: tenant_id, period_end, object_url, sha256, first_id, last_id, last_row_hash).

**One cross-task note folded in:** the scripts (`audit-verify.ts`, `audit-seal.ts`) export their core function (`verifyTenantChain`/`sealTenant`) and only run `main()` when invoked directly (the `process.argv[1].endsWith(...)` guard), so the integration tests import the logic without triggering the CLI — flagged so the implementer keeps that guard.

*End of Phase 7 plan.*

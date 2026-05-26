# Phase 7 — GCP KMS Migration + Audit Hash Chain + Tamper-Evidence — Design Spec

- **Status:** Approved (brainstormed 2026-05-26)
- **Scope:** Two task-groups in one phase, per user decision to combine: **(A)** migrate the secrets/KMS layer from AWS KMS to GCP KMS (single-cloud); **(B)** add a tamper-evident hash chain to `audit_events`, a `verify-chain` CLI, and a `audit:seal` CLI that flushes sealed archives to **GCS** with a locked retention policy.
- **Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §4 (audit), §8 (audit log), §9 (compliance, KMS).
- **Builds on:** Phases 1–5 (`feat/enterprise-phase-1`).
- **Roadmap:** Phase 7. (Phase 6 dashboard intentionally deferred to after this.)

---

## 1. Decisions taken in brainstorming

1. **Single-cloud GCP.** Object storage is GCS; KMS moves from AWS to GCP. The `Kms` interface + `secrets/dek.ts` abstraction keep `secrets/store`, token-cache, and envelope logic KMS-agnostic — the swap is localized to a new adapter + config + test wiring.
2. **GCP KMS envelope = client-side DEK + KMS wrap.** GCP KMS has no AWS-style `GenerateDataKey`; `generateDataKey` generates 32 random bytes locally and calls KMS `encrypt` to wrap; `decrypt` calls KMS `decrypt`.
3. **Drop LocalStack.** No production-grade GCP KMS emulator exists. KMS integration tests use the existing in-process `createFakeKms`; real GCP KMS fidelity moves to an opt-in `GCP_LIVE=1` test. LocalStack is removed entirely (KMS and storage both leave AWS).
4. **Hash chain via DB trigger** (BEFORE INSERT, per-tenant `FOR UPDATE`), **per-tenant chains** (genesis = each tenant's first row).
5. **`audit:seal` CLI**, cron-triggerable, no always-on worker (pg-boss stays deferred to Phase 8).
6. **Defer monthly partitioning** — chain + seal operate on the single `audit_events` table.
7. **GCS with a locked retention policy**; `fake-gcs-server` for round-trip tests; an opt-in `GCS_LIVE=1` test for Bucket-Lock enforcement.

---

## PART A — GCP KMS Migration

## 2. `src/secrets/gcp-kms.ts`

Implements the existing `Kms` interface from `src/secrets/kms.ts`:

```ts
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { randomBytes } from 'node:crypto';
import type { Kms } from './kms.js';

export function createGcpKms(opts: { keyName: string; client?: KeyManagementServiceClient }): Kms {
  const client = opts.client ?? new KeyManagementServiceClient();
  return {
    async generateDataKey(/* keyArn ignored; we use opts.keyName */) {
      const plaintext = randomBytes(32);
      const [resp] = await client.encrypt({ name: opts.keyName, plaintext });
      const ciphertext = Buffer.from(resp.ciphertext as Uint8Array);
      return { plaintext, ciphertext };
    },
    async decrypt(_keyArn, ciphertext) {
      const [resp] = await client.decrypt({ name: opts.keyName, ciphertext });
      return Buffer.from(resp.plaintext as Uint8Array);
    },
  };
}
```

Notes:
- The `Kms` interface's `keyArn` parameter is ignored by the GCP adapter (the key is bound at construction via `opts.keyName`). The stored `tenant_keys.kms_key_arn` column now holds the GCP key resource name — semantics unchanged (it records *which* key wrapped the DEK); no schema change needed.
- `@google-cloud/kms` resolves credentials from `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON) automatically.

## 3. Config changes (`src/config.ts`)

Remove the AWS KMS vars; add GCP:

```ts
GCP_PROJECT_ID: z.string().min(1),
GCP_KMS_KEY_NAME: z.string().min(1),   // projects/P/locations/L/keyRings/R/cryptoKeys/K
GCS_BUCKET: z.string().min(1),
// GOOGLE_APPLICATION_CREDENTIALS is read by the GCP SDKs directly from the env — not parsed here, but documented.
```

Drop `AWS_REGION`, `AWS_KMS_KEY_ARN`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. `.env.example` updated accordingly (and a note that `GOOGLE_APPLICATION_CREDENTIALS` points at the SA JSON; for `fake-gcs-server`/tests, `STORAGE_EMULATOR_HOST` / a fake project are used).

## 4. Wiring + test-stack swap

- `src/server.ts`, `scripts/tenant-onboard.ts`, `scripts/policy.ts` (if it touches KMS — it doesn't, but verify), and every test helper currently calling `createAwsKms(...)` switch to `createGcpKms({ keyName: cfg.gcpKmsKeyName })`.
- **Delete** `src/secrets/aws-kms.ts` and `tests/integration/_helpers/localstack-kms.ts`. Remove `@aws-sdk/client-kms` from deps.
- Integration tests that needed a real KMS (`tests/integration/secrets/store.test.ts`, the token-cache test, the e2e) switch their `createAwsKms(...)` to **`createFakeKms()`** (in-process AES, already exists). These tests no longer start a KMS container — only Postgres.
- New `tests/integration/secrets/gcp-kms-live.test.ts`: `describe.skip` unless `GCP_LIVE === '1'`; when live, exercises `createGcpKms` against a real key (round-trip a DEK). Documented env: `GCP_LIVE`, `GCP_KMS_KEY_NAME`, `GOOGLE_APPLICATION_CREDENTIALS`.
- `docker-compose.dev.yml`: replace the `localstack` service with `fake-gcs-server` (`fsouza/fake-gcs-server`) for local storage; local KMS in dev uses the fake adapter (or a real GCP key if the dev has creds).

**Fidelity tradeoff (accepted):** CI KMS coverage is now the fake adapter + `gcp-kms.ts`'s own unit test (which mocks `@google-cloud/kms`'s `encrypt`/`decrypt`); real-GCP-KMS behavior is only in the opt-in `GCP_LIVE` suite.

## 5. `gcp-kms.ts` unit test

Mocks the `KeyManagementServiceClient` (inject via `opts.client`): `encrypt` returns `{ ciphertext: <wrapped> }`, `decrypt` returns `{ plaintext: <original> }`; assert `generateDataKey` returns a 32-byte plaintext + the wrapped ciphertext, and `decrypt` round-trips. A round-trip test using a fake client that actually AES-wraps proves the envelope contract.

---

## PART B — Audit Hash Chain + Tamper-Evidence + GCS Sealing

## 6. Hash chain via DB trigger (migration 0010)

Add columns + trigger to `audit_events`:

```sql
ALTER TABLE audit_events ADD COLUMN prev_hash bytea;
ALTER TABLE audit_events ADD COLUMN row_hash  bytea;

CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev bytea;
  v_canon text;
BEGIN
  -- Serialize ALL audit inserts for this tenant (incl. the genesis case, where
  -- no tail row exists to FOR UPDATE). A transaction-scoped advisory lock keyed
  -- on the tenant prevents two concurrent first-inserts from forking the chain.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

  SELECT row_hash INTO v_prev
    FROM audit_events
   WHERE tenant_id = NEW.tenant_id
   ORDER BY id DESC LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);

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
```

Journal entry `idx: 9, tag: 0010_audit_chain`.

- `digest()` needs `pgcrypto` (enabled in Phase 1).
- `NEW.id` is available in BEFORE INSERT (the `bigserial` default fires first).
- A transaction-scoped **advisory lock** (`pg_advisory_xact_lock(hashtext(tenant_id))`) serializes that tenant's audit inserts → deterministic chain, including the genesis case (no tail row to lock). SECURITY DEFINER + explicit `WHERE tenant_id = NEW.tenant_id` makes the read robust regardless of RLS context.
- The existing `createPgAuditSink` is unchanged — the trigger populates the hashes transparently. Append-only grants (Phase 1) still hold.
- `genesis = 32 zero bytes` for each tenant's first row.

**Canonical formula is the single source of truth.** The TS verifier (§8) must reproduce `concat_ws('|', …)` + `sha256(prev || utf8(canon))` exactly. The plan documents the field list + separator once; both implementations reference it.

## 7. `audit_archives` table (migration 0010, same migration)

```sql
CREATE TABLE audit_archives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  period_end    timestamptz NOT NULL,     -- the --before cutoff this seal covered
  object_url    text NOT NULL,            -- gs://bucket/audit/<tenant>/<period>.ndjson.gz
  sha256        text NOT NULL,            -- hex sha256 of the gzip
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

## 8. `verify-chain` CLI (`scripts/audit-verify.ts`)

`npm run audit:verify -- --tenant <uuid>`:
1. Under `runAsTenant`, select the tenant's `audit_events` ordered by `id`.
2. Walk: for each row, recompute `row_hash` from `prev_hash` + the canonical formula (§6) in TS; assert `prev_hash` equals the previous row's `row_hash` (genesis = 32 zeros for the first); assert recomputed `row_hash` equals stored.
3. On mismatch: print the offending `id`, emit a structured `audit.chain.broken` log + increment an OTel counter, exit 1. On success: `OK (N rows)`, exit 0.
4. `--archive <gs-url>` mode: download the sealed gzip, recompute its sha256, compare to the `audit_archives.sha256`, and re-verify the chain within the archive.

The canonical-formula TS helper lives in `src/audit/chain.ts` (`auditRowCanonical(row): string`, `chainHash(prev: Buffer, canon: string): Buffer`) — shared by the verifier and exercised by unit tests so it can't drift from the SQL.

## 9. GCS object store (`src/audit/object-store.ts`) + `audit:seal` CLI

**Object store** wraps `@google-cloud/storage`:
- `putSealedArchive({ bucket, key, body, retainUntil })` — uploads `body` (gzip), relies on the bucket's **locked retention policy** for tamper-proofing (objects can't be deleted before the retention period). Returns `gs://bucket/key`.
- `getObject(bucket, key)` — downloads for verification.
- Configurable endpoint for `fake-gcs-server` (via `STORAGE_EMULATOR_HOST` or the client's `apiEndpoint`).

**`scripts/audit-seal.ts`** (`npm run audit:seal -- --before YYYY-MM-DD [--tenant <uuid>]`):
1. Per tenant (all, or the given one): find rows with `occurred_at < --before` and `id > last_id` of the latest `audit_archives` row for that tenant.
2. Serialize id-ordered NDJSON, gzip.
3. `sha256` the gzip; build a manifest (`tenant_id, first_id, last_id, first_prev_hash, last_row_hash, count, sha256`).
4. `putSealedArchive` to `gs://$GCS_BUCKET/audit/<tenant>/<periodEnd>.ndjson.gz`.
5. Insert an `audit_archives` pointer row.
6. Idempotent via the `last_id` watermark — re-running seals nothing already sealed.

The GCS bucket must be created with a **locked retention policy (7 years)** — operator setup, documented; the seal does not create the bucket.

## 10. Testing

**Unit:**
- `src/audit/chain.ts`: `auditRowCanonical` + `chainHash` — genesis hash, a hand-computed 3-row chain, field-null handling.
- `src/secrets/gcp-kms.ts`: mocked KMS client round-trip (§5).

**Integration (testcontainers — Postgres + `fake-gcs-server`; NO LocalStack):**
- **Chain built by trigger:** insert 3 audit rows for a tenant → `prev_hash`/`row_hash` populated; `row[n].prev_hash == row[n-1].row_hash`; genesis = 32 zeros.
- **Tamper detection (marquee):** insert N rows; with the migration/superuser role mutate one row's `event_type`; `audit:verify` detects the break at that id + emits `audit.chain.broken`.
- **Per-tenant isolation:** two tenants' chains are independent.
- **Concurrent-insert integrity:** fire N concurrent audit inserts for one tenant (separate connections); the advisory lock serializes them so the resulting chain is unbroken and linear (verify-chain passes, no forked genesis).
- **Seal round-trip:** `audit:seal` writes gzip+manifest to `fake-gcs-server`; `audit_archives` row written; `audit:verify --archive` re-downloads, matches sha256, re-verifies the chain. Re-seal is a no-op (watermark).
- **secrets/store (migrated):** the Phase-2 integration test now uses `createFakeKms()` instead of LocalStack — still proves the envelope round-trip end-to-end.

**Opt-in live (env-gated, skipped in CI):**
- `GCP_LIVE=1`: `gcp-kms-live.test.ts` round-trips a DEK against a real GCP KMS key.
- `GCS_LIVE=1`: a live-GCS test proves Bucket-Lock enforcement — uploading then attempting to delete before retention expiry is denied.

## 11. File structure

| File | Responsibility |
|---|---|
| `src/secrets/gcp-kms.ts` (new) | GCP KMS adapter (client-side DEK + KMS wrap) |
| `src/secrets/aws-kms.ts` (delete) | — |
| `tests/integration/_helpers/localstack-kms.ts` (delete) | — |
| `src/config.ts` (mod) | GCP_PROJECT_ID/GCP_KMS_KEY_NAME/GCS_BUCKET; drop AWS_* |
| `src/audit/chain.ts` (new) | canonical formula + chainHash (shared with the SQL trigger) |
| `src/audit/object-store.ts` (new) | GCS put/get with retention |
| `migrations/0010_audit_chain.sql` (new) | prev/row_hash + trigger + audit_archives |
| `src/db/schema.ts` (mod) | audit_events hash columns + auditArchives mirror |
| `scripts/audit-verify.ts` (new) | verify-chain CLI |
| `scripts/audit-seal.ts` (new) | seal CLI |
| `src/server.ts`, `scripts/tenant-onboard.ts` (mod) | createAwsKms → createGcpKms |
| `docker-compose.dev.yml` (mod) | localstack → fake-gcs-server |
| `package.json` (mod) | + `@google-cloud/kms`, `@google-cloud/storage`, `@testcontainers/gcloud` or a fake-gcs-server container; − `@aws-sdk/client-kms` |
| tests | per §10 |

## 12. Out of scope

- Monthly partitioning (deferred to Phase 8 if volume warrants).
- pg-boss always-on workers / scheduled sealing (Phase 8) — the CLI is the unit; cron wiring is the operator's deploy concern.
- Break-glass audit stream (Phase 8/9).
- Dashboard (Phase 6, after this).
- Migrating any non-KMS AWS usage — there is none; AWS leaves the project entirely this phase.

---

*End of spec.*

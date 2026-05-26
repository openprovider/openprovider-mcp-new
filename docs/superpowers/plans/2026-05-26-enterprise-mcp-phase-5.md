# Enterprise Openprovider MCP — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five Openprovider write tools (`register_domain`, `update_domain`, `create_contact`, `update_contact`, `delete_contact`) on Phase 4's confirmation machinery, with strict (non-mutating) argument validation and a two-layer dedup: an atomic claim-before-execute for confirm-mode billable/destructive ops, and a local `idempotency_records` table for allow-mode `create_contact`.

**Architecture:** Write methods extend the existing `openprovider/client`. Tools are plain factories that ride Phase 4's data-driven policy modes (no new dispatcher branch). Confirm-mode execution claims the confirmation atomically (`UPDATE … SET consumed_at=now() WHERE consumed_at IS NULL RETURNING`) before the upstream write; allow-mode `create_contact` wraps its handler in `withIdempotency`. Writes are Nock-tested only; non-billable contact ops have an opt-in live-sandbox suite. **`register_domain` is never executed against the live sandbox.**

**Tech Stack:** unchanged (Fastify 4, Drizzle, pg, zod, Vitest, testcontainers, nock). No new deps.

**Spec:** `docs/superpowers/specs/2026-05-26-phase5-write-tools-design.md`
**Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §6
**Branch:** stacks on `feat/enterprise-phase-1`. **NEVER push** — orchestrator pushes after user confirmation.

---

## File structure

| File | Responsibility |
|---|---|
| `src/openprovider/types.ts` (mod) | `RegisterDomainArgs`, `UpdateDomainArgs`, `CreateContactArgs`, `UpdateContactArgs` zod schemas |
| `src/openprovider/client.ts` (mod) | `registerDomain`/`updateDomain`/`createContact`/`updateContact`/`deleteContact` (+ optional idempotency header) |
| `migrations/0009_idempotency_records.sql` (new) | idempotency table + RLS |
| `src/db/schema.ts` (mod) | `idempotencyRecords` mirror |
| `src/policies/idempotency.ts` (new) | `idempotencyKeyFor`, `withIdempotency`, `claimConfirmation`, `unclaimConfirmation` |
| `src/tools/register-domain.ts`, `update-domain.ts`, `create-contact.ts`, `update-contact.ts`, `delete-contact.ts` (new) | tool factories |
| `src/server.ts` (mod) | register the 5 tools; claim-before-execute in the confirm consume sites; `withIdempotency` for `create_contact` |
| `tests/...` | unit (Nock) + integration + e2e + opt-in live sandbox |

**Task order:** schemas → client methods → migration → idempotency module → tool factories → server wiring (the tricky claim integration) → e2e → docs/tag.

---

## Task 1: Strict write-arg schemas (validate, never mutate)

**Files:**
- Modify: `src/openprovider/types.ts`
- Create: `src/openprovider/write-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  RegisterDomainArgs, UpdateDomainArgs, CreateContactArgs, UpdateContactArgs,
} from './types.js';

describe('write arg schemas — strict, no mutation', () => {
  it('accepts a valid register_domain payload', () => {
    const parsed = RegisterDomainArgs.parse({
      domain: { name: 'example', extension: 'com' }, period: 1, owner_handle: 'AB123',
    });
    expect(parsed.period).toBe(1);
  });

  it('rejects register_domain with period 0', () => {
    expect(() => RegisterDomainArgs.parse({ domain: { name: 'x', extension: 'com' }, period: 0, owner_handle: 'A' })).toThrow();
  });

  it('rejects register_domain without owner_handle', () => {
    expect(() => RegisterDomainArgs.parse({ domain: { name: 'x', extension: 'com' }, period: 1 })).toThrow();
  });

  it('accepts a valid create_contact and does NOT mutate the phone', () => {
    const parsed = CreateContactArgs.parse({
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+91', subscriber_number: '9876543210' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '110001', country: 'IN' },
    });
    // No India area-code splitting — subscriber_number passes through unchanged.
    expect(parsed.phone.subscriber_number).toBe('9876543210');
    expect(parsed.phone.area_code).toBeUndefined();
  });

  it('rejects create_contact missing last_name', () => {
    expect(() => CreateContactArgs.parse({
      name: { first_name: 'A' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
    })).toThrow();
  });

  it('rejects create_contact with a 3-letter country', () => {
    expect(() => CreateContactArgs.parse({
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'USA' },
    })).toThrow();
  });

  it('does NOT default role or is_active on create_contact', () => {
    const parsed = CreateContactArgs.parse({
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
    });
    expect((parsed as { role?: string }).role).toBeUndefined();
  });

  it('update_contact requires id', () => {
    expect(() => UpdateContactArgs.parse({ email: 'a@b.co' })).toThrow();
    expect(UpdateContactArgs.parse({ id: 7, email: 'a@b.co' }).id).toBe(7);
  });

  it('update_domain requires positive id', () => {
    expect(() => UpdateDomainArgs.parse({ id: 0 })).toThrow();
    expect(UpdateDomainArgs.parse({ id: 5, autorenew: 'on' }).id).toBe(5);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- write-types`
Expected: FAIL — schemas not exported.

- [ ] **Step 3: Add the schemas to `src/openprovider/types.ts`**

```ts
export const RegisterDomainArgs = z.object({
  domain: z.object({ name: z.string().min(1), extension: z.string().min(1) }),
  period: z.number().int().min(1).max(10),
  owner_handle: z.string().min(1),
  admin_handle: z.string().optional(),
  tech_handle: z.string().optional(),
  billing_handle: z.string().optional(),
  name_servers: z.array(z.object({
    name: z.string().min(1), ip: z.string().optional(), ip6: z.string().optional(),
  })).optional(),
  ns_group: z.string().optional(),
  is_private_whois_enabled: z.boolean().optional(),
  is_dnssec_enabled: z.boolean().optional(),
  autorenew: z.enum(['on', 'off', 'default']).optional(),
});
export type RegisterDomainArgs = z.infer<typeof RegisterDomainArgs>;

export const UpdateDomainArgs = z.object({
  id: z.number().int().positive(),
  name_servers: z.array(z.object({ name: z.string().min(1), ip: z.string().optional(), ip6: z.string().optional() })).optional(),
  ns_group: z.string().optional(),
  is_private_whois_enabled: z.boolean().optional(),
  is_dnssec_enabled: z.boolean().optional(),
  autorenew: z.enum(['on', 'off', 'default']).optional(),
});
export type UpdateDomainArgs = z.infer<typeof UpdateDomainArgs>;

const ContactName = z.object({
  first_name: z.string().min(1), last_name: z.string().min(1),
  full_name: z.string().optional(), initials: z.string().optional(), prefix: z.string().optional(),
});
const ContactPhone = z.object({
  country_code: z.string().min(1), subscriber_number: z.string().min(1), area_code: z.string().optional(),
});
const ContactAddress = z.object({
  street: z.string().min(1), number: z.string().min(1), city: z.string().min(1),
  zipcode: z.string().min(1), country: z.string().length(2),
  state: z.string().optional(), suffix: z.string().optional(),
});

export const CreateContactArgs = z.object({
  name: ContactName, phone: ContactPhone, address: ContactAddress,
  email: z.string().email().optional(),
  company_name: z.string().optional(), vat: z.string().optional(),
  gender: z.enum(['M', 'F']).optional(),
  role: z.enum(['admin', 'tech', 'billing', 'owner']).optional(),
}).passthrough();
export type CreateContactArgs = z.infer<typeof CreateContactArgs>;

export const UpdateContactArgs = z.object({ id: z.number().int().positive() })
  .merge(CreateContactArgs.partial());
export type UpdateContactArgs = z.infer<typeof UpdateContactArgs>;
```

Add `src/openprovider/types.ts` is already coverage-excluded (Phase 2). No vitest change.

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- write-types && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/openprovider/types.ts src/openprovider/write-types.test.ts
git commit -m "feat(phase5): strict write-arg schemas (no legacy mutation)"
```

---

## Task 2: Openprovider client write methods

**Files:**
- Modify: `src/openprovider/client.ts`
- Create: `src/openprovider/client-writes.test.ts`

- [ ] **Step 1: Write the failing test (Nock)**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { createOpenproviderClient } from './client.js';
import { OpenproviderAuthError, OpenproviderClientError } from './errors.js';

describe('openprovider client — write methods', () => {
  afterEach(() => nock.cleanAll());

  it('registerDomain POSTs /domains and unwraps data', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/domains').reply(200, { data: { id: 99, status: 'ACT' } });
    const client = createOpenproviderClient();
    const r = (await client.registerDomain('tok', {
      domain: { name: 'a', extension: 'com' }, period: 1, owner_handle: 'AB',
    })) as { id: number };
    expect(r.id).toBe(99);
  });

  it('registerDomain sends X-Idempotency-Key when provided', async () => {
    let seen: string | undefined;
    nock('https://api.openprovider.eu').post('/v1beta/domains')
      .reply(function () { seen = this.req.headers['x-idempotency-key'] as string; return [200, { data: { id: 1 } }]; });
    const client = createOpenproviderClient();
    await client.registerDomain('tok', { domain: { name: 'a', extension: 'com' }, period: 1, owner_handle: 'AB' }, 'idem-123');
    expect(seen).toBe('idem-123');
  });

  it('createContact POSTs /contacts', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/contacts').reply(200, { data: { handle: 'XY123' } });
    const client = createOpenproviderClient();
    const r = (await client.createContact('tok', {
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
    })) as { handle: string };
    expect(r.handle).toBe('XY123');
  });

  it('updateContact PUTs /contacts/:id', async () => {
    nock('https://api.openprovider.eu').put('/v1beta/contacts/7').reply(200, { data: { handle: 'XY123' } });
    const client = createOpenproviderClient();
    await client.updateContact('tok', 7, { id: 7, email: 'a@b.co' });
  });

  it('deleteContact DELETEs /contacts/:id', async () => {
    nock('https://api.openprovider.eu').delete('/v1beta/contacts/7').reply(200, { data: { success: true } });
    const client = createOpenproviderClient();
    await client.deleteContact('tok', 7);
  });

  it('updateDomain PUTs /domains/:id', async () => {
    nock('https://api.openprovider.eu').put('/v1beta/domains/42').reply(200, { data: { id: 42 } });
    const client = createOpenproviderClient();
    await client.updateDomain('tok', 42, { id: 42, autorenew: 'on' });
  });

  it('maps a 401 on a write to OpenproviderAuthError', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/domains').reply(401, {});
    const client = createOpenproviderClient();
    await expect(client.registerDomain('tok', { domain: { name: 'a', extension: 'com' }, period: 1, owner_handle: 'AB' }))
      .rejects.toBeInstanceOf(OpenproviderAuthError);
  });

  it('maps a 4xx on a write to OpenproviderClientError', async () => {
    nock('https://api.openprovider.eu').post('/v1beta/contacts').reply(400, { desc: 'bad' });
    const client = createOpenproviderClient();
    await expect(client.createContact('tok', {
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
    })).rejects.toBeInstanceOf(OpenproviderClientError);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- client-writes`

- [ ] **Step 3: Extend `OpenproviderClient` interface + implement the methods**

Add to the interface:

```ts
registerDomain(token: string, args: RegisterDomainArgs, idempotencyKey?: string): Promise<unknown>;
updateDomain(token: string, id: number, args: UpdateDomainArgs, idempotencyKey?: string): Promise<unknown>;
createContact(token: string, args: CreateContactArgs, idempotencyKey?: string): Promise<unknown>;
updateContact(token: string, id: number, args: UpdateContactArgs, idempotencyKey?: string): Promise<unknown>;
deleteContact(token: string, id: number, idempotencyKey?: string): Promise<unknown>;
```

The existing `request(method, path, token, body?)` helper must accept an optional headers map for the idempotency key. Extend it:

```ts
async function request(method: string, path: string, token: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
  // ... inside the fetch headers object, spread: ...(extraHeaders ?? {})
}
```

Implement the methods in the returned object (strip `id` from the PUT body since it's in the path; pass remaining args as body):

```ts
async registerDomain(token, args, idempotencyKey) {
  const parsed = RegisterDomainArgs.parse(args);
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
  const body = await request('POST', '/domains', token, parsed, headers);
  return (body as { data?: unknown }).data ?? body;
},
async updateDomain(token, id, args, idempotencyKey) {
  const parsed = UpdateDomainArgs.parse(args);
  const { id: _id, ...rest } = parsed;
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
  const body = await request('PUT', `/domains/${id}`, token, rest, headers);
  return (body as { data?: unknown }).data ?? body;
},
async createContact(token, args, idempotencyKey) {
  const parsed = CreateContactArgs.parse(args);
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
  const body = await request('POST', '/contacts', token, parsed, headers);
  return (body as { data?: unknown }).data ?? body;
},
async updateContact(token, id, args, idempotencyKey) {
  const parsed = UpdateContactArgs.parse(args);
  const { id: _id, ...rest } = parsed;
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
  const body = await request('PUT', `/contacts/${id}`, token, rest, headers);
  return (body as { data?: unknown }).data ?? body;
},
async deleteContact(token, id, idempotencyKey) {
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
  const body = await request('DELETE', `/contacts/${id}`, token, undefined, headers);
  return (body as { data?: unknown }).data ?? body;
},
```

> If `checkDomain` wraps in an opossum breaker, wrap the writes similarly for parity (one breaker per endpoint) — but a shared breaker is acceptable; match the existing pattern. The retry logic in `request` already covers transient upstream errors.

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- client-writes && npm test -- openprovider/client && npm run typecheck && npm run lint`
(Re-run the existing client tests to confirm the `request` signature change didn't break `checkDomain`/read methods.)

- [ ] **Step 5: Commit**

```bash
git add src/openprovider/client.ts src/openprovider/client-writes.test.ts
git commit -m "feat(phase5): openprovider client write methods + optional idempotency header"
```

---

## Task 3: Migration 0009 — `idempotency_records`

**Files:**
- Create: `migrations/0009_idempotency_records.sql`
- Modify: `migrations/meta/_journal.json`
- Modify: `src/db/schema.ts`
- Create: `tests/integration/db/idempotency-migration.test.ts`

- [ ] **Step 1: Write `migrations/0009_idempotency_records.sql`**

```sql
CREATE TABLE idempotency_records (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  tool_name   text NOT NULL,
  result_json jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_records_isolation ON idempotency_records
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT ON idempotency_records TO app_role;
CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);
```

- [ ] **Step 2: Journal entry**

```json
{ "idx": 8, "version": "5", "when": 1748400000000, "tag": "0009_idempotency_records", "breakpoints": true }
```

- [ ] **Step 3: Schema mirror in `src/db/schema.ts`** (reuse `jsonb`):

```ts
export const idempotencyRecords = pgTable('idempotency_records', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  key: text('key').notNull(),
  toolName: text('tool_name').notNull(),
  resultJson: jsonb('result_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
```

- [ ] **Step 4: Migration sanity test** `tests/integration/db/idempotency-migration.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';

const T = '00000000-0000-0000-0000-0000000000e1';

describe('migration 0009 idempotency_records', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres(); const m = await migratedDb(fixture.url); pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]); } finally { c.release(); }
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('inserts + reads a record under RLS', async () => {
    await runAsTenant(pool, T, async (c) => {
      await c.query(
        `INSERT INTO idempotency_records (tenant_id, key, tool_name, result_json, expires_at)
         VALUES ($1,'k1','create_contact','{"handle":"X"}'::jsonb, now() + interval '10 min')`, [T]);
      const r = await c.query<{ result_json: { handle: string } }>(`SELECT result_json FROM idempotency_records WHERE key='k1'`);
      expect(r.rows[0]?.result_json.handle).toBe('X');
    });
  });
});
```

- [ ] **Step 5: Run**

Run: `npm run test:integration -- idempotency-migration && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add migrations/0009_idempotency_records.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/idempotency-migration.test.ts
git commit -m "feat(phase5): migration 0009 idempotency_records table"
```

---

## Task 4: idempotency module — keys, withIdempotency, claim/unclaim

**Files:**
- Create: `src/policies/idempotency.ts`
- Create: `src/policies/idempotency.test.ts` (unit, key derivation)
- Create: `tests/integration/policies/idempotency.test.ts` (integration, replay + claim)

- [ ] **Step 1: Write `src/policies/idempotency.ts`**

```ts
import { createHash } from 'node:crypto';
import type pg from 'pg';

const WINDOW_MS = 10 * 60 * 1000;

export function idempotencyKeyFor(
  tool: string, args: unknown, tenantId: string, confirmationId?: string,
): string {
  if (confirmationId) return confirmationId;
  const canonical = JSON.stringify(args, Object.keys(args as object).sort());
  return createHash('sha256').update(tool).update('|').update(canonical).update('|').update(tenantId).digest('hex');
}

export async function withIdempotency<T>(
  client: pg.PoolClient, tenantId: string, key: string, toolName: string, fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const hit = await client.query<{ result_json: T }>(
    `SELECT result_json FROM idempotency_records WHERE tenant_id = $1 AND key = $2 AND expires_at > now()`,
    [tenantId, key],
  );
  if (hit.rows[0]) return { result: hit.rows[0].result_json, replayed: true };
  const result = await fn();
  await client.query(
    `INSERT INTO idempotency_records (tenant_id, key, tool_name, result_json, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, key, toolName, JSON.stringify(result)],
  );
  return { result, replayed: false };
}

/** Atomically claim a confirmation for execution. Returns true if THIS caller won the claim. */
export async function claimConfirmation(client: pg.PoolClient, confirmationId: string): Promise<boolean> {
  const r = await client.query(
    `UPDATE confirmations SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [confirmationId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Release a claim (on upstream failure) so the confirmation is re-approvable. */
export async function unclaimConfirmation(client: pg.PoolClient, confirmationId: string): Promise<void> {
  await client.query(`UPDATE confirmations SET consumed_at = NULL WHERE id = $1`, [confirmationId]);
}

export { WINDOW_MS };
```

> Note `consumed_at` needs `UPDATE` grant for `app_role` on `confirmations` — it was granted `SELECT, INSERT, UPDATE` in Phase 4's migration 0008, so this works.

- [ ] **Step 2: Write the unit test `src/policies/idempotency.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { idempotencyKeyFor } from './idempotency.js';

describe('idempotencyKeyFor', () => {
  it('returns the confirmation id when present', () => {
    expect(idempotencyKeyFor('register_domain', { a: 1 }, 't', 'conf-1')).toBe('conf-1');
  });
  it('auto-hashes args order-insensitively when no confirmation id', () => {
    const k1 = idempotencyKeyFor('create_contact', { a: 1, b: 2 }, 't');
    const k2 = idempotencyKeyFor('create_contact', { b: 2, a: 1 }, 't');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('differs by tenant and tool', () => {
    expect(idempotencyKeyFor('create_contact', { a: 1 }, 't1')).not.toBe(idempotencyKeyFor('create_contact', { a: 1 }, 't2'));
    expect(idempotencyKeyFor('create_contact', { a: 1 }, 't')).not.toBe(idempotencyKeyFor('update_contact', { a: 1 }, 't'));
  });
});
```

- [ ] **Step 3: Write the integration test `tests/integration/policies/idempotency.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { withIdempotency, claimConfirmation } from '../../../src/policies/idempotency.js';
import { upsertPolicy, proposeConfirmation } from '../../../src/policies/repo.js';
import { DEFAULT_POLICY } from '../../../src/policies/schema.js';

const T = '00000000-0000-0000-0000-0000000000e2';

describe('idempotency integration', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres(); const m = await migratedDb(fixture.url); pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]); } finally { c.release(); }
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('withIdempotency executes once then replays', async () => {
    await runAsTenant(pool, T, async (c) => {
      const fn = vi.fn().mockResolvedValue({ handle: 'X' });
      const first = await withIdempotency(c, T, 'k-replay', 'create_contact', fn);
      expect(first.replayed).toBe(false);
      const second = await withIdempotency(c, T, 'k-replay', 'create_contact', fn);
      expect(second.replayed).toBe(true);
      expect(second.result).toEqual({ handle: 'X' });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  it('claimConfirmation: only the first claim wins', async () => {
    await runAsTenant(pool, T, async (c) => {
      await upsertPolicy(c, T, { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 } });
      const rec = await proposeConfirmation({
        client: c, tenantId: T, principalSubject: 's', toolName: 'register_domain',
        args: { domain: { name: 'a', extension: 'com' }, period: 1 }, summaryText: 'r',
        estimatedCostCents: 1000, requiredApproverRoles: ['owner'], ttlMs: 300_000,
      });
      expect(await claimConfirmation(c, rec.id)).toBe(true);   // first claim wins
      expect(await claimConfirmation(c, rec.id)).toBe(false);  // already claimed
    });
  });
});
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- policies/idempotency && npm run test:integration -- policies/idempotency`

- [ ] **Step 5: Add `src/policies/idempotency.ts` integration-only paths to coverage exclude if needed** (the unit test covers `idempotencyKeyFor`; `withIdempotency`/`claim` are integration-tested). Add to `vitest.config.ts` exclude only if coverage dips.

- [ ] **Step 6: Commit**

```bash
git add src/policies/idempotency.ts src/policies/idempotency.test.ts tests/integration/policies/idempotency.test.ts vitest.config.ts
git commit -m "feat(phase5): idempotency module — keys, withIdempotency replay, atomic claim/unclaim"
```

---

## Task 5: Five write-tool factories

**Files:**
- Create: `src/tools/register-domain.ts`, `src/tools/update-domain.ts`, `src/tools/create-contact.ts`, `src/tools/update-contact.ts`, `src/tools/delete-contact.ts`
- Create: `src/tools/write-tools.test.ts`

- [ ] **Step 1: Write the five factories** (each mirrors `check-domain.ts`).

`src/tools/register-domain.ts`:

```ts
import { RegisterDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createRegisterDomainTool(deps: { client: OpenproviderClient; tokenManager: OpenproviderTokenManager }) {
  return {
    name: 'register_domain',
    description: 'Register a new domain (billable). Requires an existing owner contact handle.',
    inputSchema: RegisterDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = RegisterDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.registerDomain(token, parsed);
    },
  };
}
```

`src/tools/update-domain.ts`:

```ts
import { UpdateDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdateDomainTool(deps: { client: OpenproviderClient; tokenManager: OpenproviderTokenManager }) {
  return {
    name: 'update_domain',
    description: 'Update a domain (nameservers, autorenew, DNSSEC, WHOIS privacy).',
    inputSchema: UpdateDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdateDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updateDomain(token, parsed.id, parsed);
    },
  };
}
```

`src/tools/create-contact.ts`:

```ts
import { CreateContactArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createCreateContactTool(deps: { client: OpenproviderClient; tokenManager: OpenproviderTokenManager }) {
  return {
    name: 'create_contact',
    description: 'Create a new contact (handle) in the tenant’s Openprovider account.',
    inputSchema: CreateContactArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = CreateContactArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.createContact(token, parsed);
    },
  };
}
```

`src/tools/update-contact.ts`:

```ts
import { UpdateContactArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createUpdateContactTool(deps: { client: OpenproviderClient; tokenManager: OpenproviderTokenManager }) {
  return {
    name: 'update_contact',
    description: 'Update an existing contact by id.',
    inputSchema: UpdateContactArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = UpdateContactArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.updateContact(token, parsed.id, parsed);
    },
  };
}
```

`src/tools/delete-contact.ts`:

```ts
import { z } from 'zod';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export const DeleteContactArgs = z.object({ id: z.number().int().positive() });

export function createDeleteContactTool(deps: { client: OpenproviderClient; tokenManager: OpenproviderTokenManager }) {
  return {
    name: 'delete_contact',
    description: 'Delete a contact by id (destructive).',
    inputSchema: DeleteContactArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = DeleteContactArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.deleteContact(token, parsed.id);
    },
  };
}
```

- [ ] **Step 2: Write `src/tools/write-tools.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createRegisterDomainTool } from './register-domain.js';
import { createUpdateDomainTool } from './update-domain.js';
import { createCreateContactTool } from './create-contact.js';
import { createUpdateContactTool } from './update-contact.js';
import { createDeleteContactTool } from './delete-contact.js';
import type { Principal } from '../auth/principal.js';

const principal: Principal = { kind: 'user', tenantId: 't1', userId: 'u', subject: 's', scopes: [], role: 'owner' };

function deps() {
  return {
    client: {
      checkDomain: vi.fn(), listDomains: vi.fn(), getDomain: vi.fn(), listContacts: vi.fn(), getContact: vi.fn(),
      registerDomain: vi.fn().mockResolvedValue({ id: 99 }),
      updateDomain: vi.fn().mockResolvedValue({ id: 42 }),
      createContact: vi.fn().mockResolvedValue({ handle: 'XY' }),
      updateContact: vi.fn().mockResolvedValue({ handle: 'XY' }),
      deleteContact: vi.fn().mockResolvedValue({ success: true }),
    },
    tokenManager: { getToken: vi.fn().mockResolvedValue('jwt'), invalidate: vi.fn() },
  };
}

describe('write tools', () => {
  it('register_domain gets token then calls client.registerDomain', async () => {
    const d = deps();
    const r = (await createRegisterDomainTool(d).handler(
      { domain: { name: 'a', extension: 'com' }, period: 1, owner_handle: 'AB' }, principal,
    )) as { id: number };
    expect(r.id).toBe(99);
    expect(d.tokenManager.getToken).toHaveBeenCalledWith('t1');
  });
  it('update_domain passes id from args', async () => {
    const d = deps();
    await createUpdateDomainTool(d).handler({ id: 42, autorenew: 'on' }, principal);
    expect(d.client.updateDomain).toHaveBeenCalledWith('jwt', 42, expect.objectContaining({ id: 42 }));
  });
  it('create_contact calls client.createContact', async () => {
    const d = deps();
    await createCreateContactTool(d).handler({
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
    }, principal);
    expect(d.client.createContact).toHaveBeenCalled();
  });
  it('update_contact + delete_contact call their methods', async () => {
    const d = deps();
    await createUpdateContactTool(d).handler({ id: 7, email: 'a@b.co' }, principal);
    await createDeleteContactTool(d).handler({ id: 7 }, principal);
    expect(d.client.updateContact).toHaveBeenCalledWith('jwt', 7, expect.objectContaining({ id: 7 }));
    expect(d.client.deleteContact).toHaveBeenCalledWith('jwt', 7);
  });
  it('register_domain rejects period 0 at the schema', async () => {
    await expect(createRegisterDomainTool(deps()).handler({ domain: { name: 'a', extension: 'com' }, period: 0, owner_handle: 'AB' }, principal)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run, expect PASS**

Run: `npm test -- write-tools && npm run typecheck && npm run lint`

- [ ] **Step 4: Commit**

```bash
git add src/tools/register-domain.ts src/tools/update-domain.ts src/tools/create-contact.ts src/tools/update-contact.ts src/tools/delete-contact.ts src/tools/write-tools.test.ts
git commit -m "feat(phase5): register_domain, update_domain, create/update/delete_contact tool factories"
```

---

## Task 6: Server wiring — register tools + claim-before-execute + create_contact idempotency

**Files:**
- Modify: `src/server.ts`

This is the integration crossroads. Read the current `dispatchFactory` (Phase 4) carefully first — specifically the `confirm.consume`, the `confirmPendingConsume` closure, and `confirm.settle`.

- [ ] **Step 1: Register the five write tools** in the `dispatchFactory` `tools` array (before the meta-tools push), constructing each with `{ client: openproviderClient, tokenManager }`. Import the five factories.

- [ ] **Step 2: Add claim-before-execute to the confirm execution sites.**

The confirm-mode billable/destructive write must claim the confirmation atomically before executing. There are two execution sites from Phase 4: (a) the dispatcher's token-present consume path (it runs the tool handler then `confirm.settle`), and (b) `confirmPendingConsume` (runs the handler directly).

Import the helpers: `import { claimConfirmation, unclaimConfirmation, withIdempotency, idempotencyKeyFor } from './policies/idempotency.js';`

**For site (b) — `confirmPendingConsume`** (the primary approver path), change the execute block to claim first:

```ts
// inside confirmPendingConsume, after validateConfirmation returns ok with `conf`:
const originalTool = tools.find((t) => t.name === conf.toolName);
if (!originalTool) return { kind: 'error', code: 'tool_not_found' };

// Atomic claim — prevents concurrent double-execution of a billable op.
const won = await claimConfirmation(client, conf.id);
if (!won) return { kind: 'error', code: 'confirmation_not_found' }; // already claimed/consumed

try {
  const result = await originalTool.handler(input.args, input.principal);
  // reservation → committed (the claim already set consumed_at).
  await settleConfirmation(client, conf.id, 'committed');
  return { kind: 'ok', result };
} catch (err) {
  // Un-claim so a transient failure leaves the confirmation re-approvable.
  await unclaimConfirmation(client, conf.id);
  await settleConfirmation(client, conf.id, 'released');
  const code = (err as { code?: string }).code ?? 'upstream_error';
  return { kind: 'error', code };
}
```

> `validateConfirmation` already checks `consumed_at` (rejects if set) BEFORE this claim, so the claim is the final atomic gate. Note: `settleConfirmation('committed')` also sets `consumed_at = now()` — harmless since the claim already did. The key change is that the claim's `RETURNING` row-count is what authorizes execution.

**For site (a) — the dispatcher's `confirm.consume`** (same-principal re-call with token): the dispatcher (Phase 4) does `consume → run handler → settle`. Add the claim inside `confirm.consume` so the dispatcher's subsequent handler run is gated. Change `confirm.consume`:

```ts
consume: async ({ token, args, principal: p }) => {
  const validated = await validateConfirmation(token, args, p);
  if (validated.kind === 'error') return validated;
  const won = await claimConfirmation(client, validated.conf.id);
  if (!won) return { kind: 'error', code: 'confirmation_not_found' };
  return { kind: 'ok', confirmationId: validated.conf.id };
},
```

And the dispatcher's `settle` (Phase 4 `confirm.settle`) must un-claim on `released`:

```ts
settle: async (confirmationId, outcome) => {
  if (outcome === 'released') await unclaimConfirmation(client, confirmationId);
  await settleConfirmation(client, confirmationId, outcome);
},
```

> Since `claimConfirmation` set `consumed_at` already, a later `validateConfirmation` for a duplicate would see it consumed → `confirmation_not_found`. The `unclaimConfirmation` on release resets it so the user can re-approve after a transient failure.

- [ ] **Step 3: Wrap `create_contact` (allow-mode) in `withIdempotency`.**

`create_contact` has no confirmation, so dedup uses the auto-hash key. Wrap its handler at registration:

```ts
// after building the base tools array, replace the create_contact entry with a wrapped one:
const createContactTool = createCreateContactTool({ client: openproviderClient, tokenManager });
const wrappedCreateContact = {
  ...createContactTool,
  handler: async (args: unknown, p: Principal): Promise<unknown> => {
    const key = idempotencyKeyFor('create_contact', args, p.tenantId);
    const { result } = await withIdempotency(client, p.tenantId, key, 'create_contact', () =>
      createContactTool.handler(args, p),
    );
    return result;
  },
};
// register wrappedCreateContact instead of the bare createContactTool.
```

> Confirm-mode writes don't need `withIdempotency` for correctness (the claim guarantees single execution), but for sequential-retry replay you MAY also record their result. Phase 5 keeps it simple: the claim is the guarantee; only `create_contact` uses `withIdempotency`. (The spec's "defense-in-depth replay for confirm-mode" is optional and deferred — note this in the commit.)

- [ ] **Step 4: Build + typecheck + lint + full unit tests**

Run: `npm run build && npm run typecheck && npm run lint && npm test`
Expected: all green. (The e2e in Task 7 proves the wired behavior.)

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(phase5): register write tools; claim-before-execute for confirm-mode; idempotent create_contact

Confirm-mode billable/destructive writes atomically claim the confirmation
(UPDATE ... WHERE consumed_at IS NULL RETURNING) before executing, preventing
concurrent double-execution; failure un-claims for re-approval. create_contact
(allow-mode) dedups via withIdempotency on an args hash. Confirm-mode replay
cache deferred (claim is the correctness guarantee)."
```

---

## Task 7: E2E — approver register_domain + replay + concurrent-claim marquee

**Files:**
- Modify: `tests/integration/mcp/e2e.test.ts`

- [ ] **Step 1: Add three Phase-5 scenarios** to the e2e suite (the suite already wires a real server with `resolveTenant` + the Phase-4 confirm machinery; the production server registers the real write tools, so the e2e can use the real `register_domain`/`create_contact` with Nock-mocked upstream).

Scenario 5a — **approver register_domain happy path** (Nock upstream):
- Provision a tenant; raise cap to €100 via `upsertPolicy`; seed Openprovider creds (so `fetchCredentials` works).
- Nock `POST /v1beta/auth/login` (token) + `POST /v1beta/domains/check` (price €12.99) + `POST /v1beta/domains` (registration result).
- As the tenant owner: call `register_domain` (no confirm token) → `confirmation_required`.
- Call `confirm_pending(confirmation_id, args)` → success; assert exactly **one** Nock `POST /v1beta/domains` fired; reservation committed; live spend = 1299.

Scenario 5b — **create_contact idempotent replay**:
- Nock `POST /v1beta/contacts` ONCE.
- Call `create_contact` with a full valid payload twice (identical args) in two sessions.
- Assert the second returns the same result with no second upstream POST (the single Nock interceptor is consumed once; a second would 404/error if a second call fired — assert it did not).

Scenario 5c — **concurrent-claim marquee**:
- Propose `register_domain` once (cap raised). Nock `POST /v1beta/domains` ONCE.
- Fire two **concurrent** `confirm_pending` calls with the same `confirmation_id` (Promise.all).
- Assert exactly one succeeds and one returns `confirmation_not_found`; the Nock `POST /domains` fired exactly once (the second concurrent claim lost the atomic `UPDATE … RETURNING`).

> Use the existing `initializeSession`/`callTool` helpers. For concurrency, open two sessions (or reuse one) and `Promise.all` two `confirm_pending` tool calls. Because each MCP request gets its own dispatchFactory transaction/connection, the atomic claim across the two connections is the real test.

- [ ] **Step 2: Run, expect PASS**

Run: `npm run test:integration -- mcp/e2e`
Expected: all scenarios pass; in 5c exactly one upstream `POST /domains`.

- [ ] **Step 3: Full integration sweep**

Run: `npm run test:integration`
Expected: all green (with `retry: 2` from Phase 4 covering any container flake).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/mcp/e2e.test.ts
git commit -m "test(phase5): e2e approver register_domain + create_contact replay + concurrent-claim marquee"
```

---

## Task 8: Opt-in live-sandbox contact round-trip (nightly, env-gated)

**Files:**
- Create: `tests/integration/openprovider/live-contacts.test.ts`

- [ ] **Step 1: Write an env-gated live test** that only runs when `OPENPROVIDER_LIVE=1` + real sandbox creds are present; otherwise `describe.skip`.

```ts
import { describe, expect, it } from 'vitest';

const LIVE = process.env.OPENPROVIDER_LIVE === '1';
const d = LIVE ? describe : describe.skip;

d('live sandbox — contact round trip (NON-BILLABLE; no domain registration)', () => {
  it('create → get → update → delete a contact', async () => {
    // Build a real OpenproviderClient + tokenManager from env (OPENPROVIDER_SANDBOX_USERNAME/PASSWORD),
    // create a contact, fetch it, update its email, delete it. Assert each step's shape.
    // NOTE: never calls registerDomain. Uses the Openprovider sandbox/test endpoint only.
    expect(LIVE).toBe(true);
  }, 60_000);
});
```

> The full live test body wires a real client against the sandbox using env creds. Keep it minimal and clearly NON-BILLABLE. It is skipped in normal CI; a nightly workflow sets `OPENPROVIDER_LIVE=1`. Document the env vars in the test header comment.

- [ ] **Step 2: Confirm it SKIPS by default**

Run: `npm run test:integration -- live-contacts`
Expected: tests skipped (0 run) when `OPENPROVIDER_LIVE` is unset.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/openprovider/live-contacts.test.ts
git commit -m "test(phase5): opt-in live-sandbox contact round-trip (env-gated, non-billable)"
```

---

## Task 9: README + CHANGELOG + `v0.6.0-phase5` tag (local only)

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `README.md`** — status → Phase 5; tools table marks `register_domain`, `update_domain`, `create_contact`, `update_contact`, `delete_contact` live (confirm-mode noted for the four; `create_contact` allow-mode); add a short "Write operations" note (confirm tools require propose→approve; idempotent; register never auto-registers contacts — create the owner contact first).

- [ ] **Step 2: Prepend `## [0.6.0-phase5] — 2026-05-26` to `CHANGELOG.md`**

```markdown
## [0.6.0-phase5] — 2026-05-26

### Added
- Write tools: register_domain, update_domain (confirm-mode, billable), create_contact (allow-mode), update_contact + delete_contact (confirm-mode).
- Strict zod arg schemas for writes; the legacy silent mutation (India phone area-code splitting, role/is_active defaulting, auto-username) is gone — malformed input is rejected.
- idempotency_records table (migration 0009) + withIdempotency replay for allow-mode create_contact (10-min window, auto-hash key).
- Claim-before-execute for confirm-mode writes: atomic UPDATE confirmations SET consumed_at WHERE consumed_at IS NULL RETURNING gates execution, preventing concurrent double-execution of billable/destructive ops; failure un-claims for re-approval.
- Optional X-Idempotency-Key header sent upstream best-effort.
- Opt-in live-sandbox contact round-trip test (non-billable; env-gated). register_domain is never executed against the live sandbox.

### Changed
- Write tools ride Phase 4's data-driven policy modes — no new dispatcher branch.

### Deferred
- Dashboard + API keys (Phase 6); pg-boss workers (Phase 7); domain transfer/trade/renew/restore/authcode, SSL/DNS/etc. (future).
```

- [ ] **Step 3: Commit + tag (DO NOT PUSH)**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(phase5): CHANGELOG + README for 0.6.0-phase5"
git tag -a v0.6.0-phase5 -m "Phase 5: write tools + approver workflow + idempotency"
```

- [ ] **Step 4: Verify**

Run: `git tag --list 'v0.*'`
Expected: phase1, phase2, phase3, phase4, `v0.6.0-phase5`. **DO NOT PUSH.**

---

## Phase 5 exit checklist

- [ ] 5 write tools live; strict schemas reject malformed input with no mutation (India phone passes through, role not defaulted).
- [ ] Confirm-mode claim-before-execute: concurrent double-approve fires upstream exactly once (e2e marquee).
- [ ] create_contact replay: identical args twice → one upstream POST.
- [ ] Approver flow: operator proposes register_domain → owner confirm_pending → one registration.
- [ ] Spend cap still denies over-budget register_domain.
- [ ] register_domain never hits the live sandbox; live contact round-trip skips unless `OPENPROVIDER_LIVE=1`.
- [ ] `npm test` + `npm run test:integration` green; typecheck + lint clean.
- [ ] CHANGELOG `0.6.0-phase5` + tag created locally.

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 client write methods | 2 |
| §3 strict schemas (no mutation) | 1 |
| §4 idempotency_records | 3, 4 |
| §5 tool factories + dispatcher wiring + claim/withIdempotency | 5, 6 |
| §6 approver flow exercised | 7 (scenario 5a) |
| §7 error handling | 2 (401/4xx), 6 (not_connected via existing fetchCredentials) |
| §8 tests (unit/integration/e2e/live) | 1–8 |

**Placeholder scan:** Task 8's live test body is intentionally a skipped stub (the env-gated real wiring is described in the note; it never runs in CI) — this is a deliberate opt-in harness, not a gap. Task 6's confirm-mode replay-cache is explicitly deferred with rationale (the claim is the correctness guarantee). No "TBD".

**Type consistency:** `RegisterDomainArgs`/`UpdateDomainArgs`/`CreateContactArgs`/`UpdateContactArgs` (Task 1) used by client (Task 2) + tools (Task 5). `withIdempotency`/`idempotencyKeyFor`/`claimConfirmation`/`unclaimConfirmation` (Task 4) used in server (Task 6). Client method signatures (Task 2, with `idempotencyKey?` last) match the tool calls (Task 5, which omit the key — the server's claim/withIdempotency layer owns dedup, not the tool). `settleConfirmation`/`validateConfirmation`/`confirmPendingConsume` references (Task 6) match the Phase 4 names.

**One consistency note folded in:** the tool factories (Task 5) call client write methods WITHOUT an idempotency key — dedup is the server layer's job (claim for confirm-mode, withIdempotency for create_contact), keeping tools simple and the dedup logic in one place. The optional upstream `X-Idempotency-Key` header is therefore not set by Phase 5's tool path; it remains available on the client methods for future use. Noted so the implementer doesn't wire keys at two layers.

*End of Phase 5 plan.*

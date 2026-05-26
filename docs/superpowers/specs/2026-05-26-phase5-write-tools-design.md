# Phase 5 — Write Tools + Approver Workflow + Idempotency — Design Spec

- **Status:** Approved (brainstormed 2026-05-26)
- **Scope:** The five Openprovider write tools (`register_domain`, `update_domain`, `create_contact`, `update_contact`, `delete_contact`) wired onto Phase 4's confirmation machinery, plus local idempotency. The confirmation flow, policy engine, spend reservations, pricing, and the `confirm_pending` approver path were all built in Phase 4 — Phase 5 adds the real billable/destructive tools + a dedup layer; it does **not** rebuild the engine.
- **Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §6.
- **Builds on:** Phases 1–4 (`feat/enterprise-phase-1`).
- **Roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md` § Phase 5.

---

## 1. Decisions taken in brainstorming

1. **Dedup is two-layered (refined during spec self-review).** Allow-mode writes (`create_contact`) use the local `idempotency_records` table keyed on `sha256(canonical(args) || tenantId || tool)` (10-min window, lazy expiry, replay stored result). Confirm-mode writes use an **atomic claim** on the confirmation (`UPDATE … SET consumed_at=now() WHERE consumed_at IS NULL RETURNING`) before executing — this prevents concurrent double-execution of billable ops, which the idempotency table alone cannot; their results are also recorded in `idempotency_records` (keyed on confirmation id) for sequential-retry replay. A benign `X-Idempotency-Key` header is sent upstream best-effort but **never relied upon**. (See §5 for the rationale.)
2. **Openprovider treated as non-idempotent.** No live spike; we make no assumptions about whether Openprovider dedups. Our local table is the sole guarantee.
3. **Nock for all write tests; live sandbox opt-in for non-billable contacts only.** `register_domain`/`update_domain` are tested against Nock fixtures exclusively — **never executed against the live sandbox in any automated suite**. `create_contact`/`update_contact`/`delete_contact` may run against the live sandbox in the opt-in nightly suite.
4. **`create_contact` stays `allow`-mode** (non-billable) with auto-hash idempotency. The other four write tools are `confirm`-mode by default policy.

---

## 2. Openprovider client — five write methods

Extend `src/openprovider/client.ts`'s `OpenproviderClient` interface and implementation:

```ts
registerDomain(token: string, args: RegisterDomainArgs): Promise<unknown>;   // POST   /domains
updateDomain(token: string, id: number, args: UpdateDomainArgs): Promise<unknown>; // PUT /domains/{id}
createContact(token: string, args: CreateContactArgs): Promise<unknown>;     // POST   /contacts
updateContact(token: string, id: number, args: UpdateContactArgs): Promise<unknown>; // PUT /contacts/{id}
deleteContact(token: string, id: number): Promise<unknown>;                  // DELETE /contacts/{id}
```

- Each reuses the existing `request()` helper (retry/timeout/typed error mapping: `OpenproviderAuthError`/`RateLimit`/`Unavailable`/`ClientError`) and is wrapped in the per-endpoint circuit-breaker pattern consistent with `checkDomain` (if `checkDomain` uses one breaker, mirror it; otherwise a shared breaker per client instance is acceptable — match the existing code).
- Responses unwrap `{ data }` and pass through (no per-field result schema — passthrough, like the Phase 3 read tools).
- Optional `idempotencyKey?: string` parameter on the write methods → sent as an `X-Idempotency-Key` request header when present (best-effort; Openprovider may ignore it).

---

## 3. Strict argument schemas — validate, never mutate

New zod schemas in `src/openprovider/types.ts`. The legacy single-file server's `processContactData` / `processUpdateContactData` behavior is **explicitly not reproduced**:

- **No** silent India `+91` area-code splitting.
- **No** `role: 'tech'` / `is_active: true` defaulting.
- **No** auto-generated `username`.

Malformed input → `validation_failed` (zod throw), never silent correction.

```ts
RegisterDomainArgs = z.object({
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

UpdateDomainArgs = z.object({
  id: z.number().int().positive(),
  name_servers: z.array(z.object({ name: z.string().min(1), ip: z.string().optional(), ip6: z.string().optional() })).optional(),
  ns_group: z.string().optional(),
  is_private_whois_enabled: z.boolean().optional(),
  is_dnssec_enabled: z.boolean().optional(),
  autorenew: z.enum(['on', 'off', 'default']).optional(),
});

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

CreateContactArgs = z.object({
  name: ContactName, phone: ContactPhone, address: ContactAddress,
  email: z.string().email().optional(),
  company_name: z.string().optional(), vat: z.string().optional(),
  gender: z.enum(['M', 'F']).optional(),
  role: z.enum(['admin', 'tech', 'billing', 'owner']).optional(),
  // additional_data, locale, comments etc. accepted as optional passthrough fields
}).passthrough();

UpdateContactArgs = z.object({ id: z.number().int().positive() })
  .merge(CreateContactArgs.partial());

GetContactByIdArgs = z.object({ id: z.number().int().positive() }); // (already exists from Phase 3)
```

> `register_domain`'s `owner_handle` is required (a contact must exist first — created via `create_contact`). The tool does not auto-create contacts.

---

## 4. `idempotency_records` (migration 0009)

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
-- RLS + FORCE + isolation policy + GRANT SELECT, INSERT to app_role (no UPDATE/DELETE needed).
CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);
```

Journal entry `idx: 8, tag: 0009_idempotency_records`.

**Repo** (`src/policies/idempotency.ts` — or `src/openprovider/idempotency.ts`; pick the home that keeps the module focused):

```ts
export function idempotencyKeyFor(tool: string, args: unknown, tenantId: string, confirmationId?: string): string;
// confirm-mode: returns confirmationId; allow-mode: sha256(canonical(args)||tenantId||tool)

export async function withIdempotency<T>(
  client: pg.PoolClient, tenantId: string, key: string, toolName: string, fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }>;
// 1. SELECT result_json WHERE (tenant_id,key) AND expires_at > now() → hit: return {result, replayed:true}
// 2. miss: run fn(); INSERT (tenant_id,key,tool_name,result_json, expires_at = now()+10min)
//          ON CONFLICT (tenant_id,key) DO NOTHING (a racing duplicate already stored);
//          return {result, replayed:false}
```

Lazy expiry: a row with `expires_at <= now()` is ignored on read (no sweep needed; matches Phase 4's lazy model). The `ON CONFLICT DO NOTHING` covers a same-key race within the window.

---

## 5. Tool factories + dispatcher wiring

`src/tools/{register-domain,update-domain,create-contact,update-contact,delete-contact}.ts`, each mirroring the Phase 2/3 factory shape: `handler: (args, principal) => { parse(args); token = tokenManager.getToken(principal.tenantId); return client.<method>(token, ...); }`. Registered in `server.ts`'s `dispatchFactory` tool list alongside the existing tools.

Because policy mode is data-driven (Phase 4's `toolMode`), these tools automatically flow through confirm/allow handling with **no new dispatcher branch**:
- `register_domain`, `update_domain`, `delete_contact`, `update_contact` → `confirm` (default policy) → propose/consume/`confirm_pending`.
- `create_contact` → `allow` → executes directly.

Pricing (Phase 4) already prices `register_domain`/`update_domain` via `checkDomain`; the contact tools price at 0.

**Two complementary dedup mechanisms — confirm-mode uses an atomic claim, allow-mode uses the idempotency table:**

**(a) Confirm-mode (`register_domain`, `update_domain`, `delete_contact`, `update_contact`) — claim-before-execute.** A confirmation is single-use, but Phase 4's consume path has a concurrency window: two simultaneous `confirm_pending` calls on the same id could both pass `validateConfirmation` (both see `consumed_at IS NULL`) and both execute the billable write. Phase 5 closes this with an **atomic claim** at the execution site:

```sql
UPDATE confirmations SET consumed_at = now()
 WHERE id = $1 AND consumed_at IS NULL
 RETURNING id;
```

If this returns **no row**, another request already claimed it → return `confirmation_not_found` (already consumed/in-flight); do **not** execute. Only a successful claim proceeds to the upstream write. This compare-and-set is the idempotency guarantee for confirm-mode — it prevents concurrent *and* sequential double-execution. On upstream **failure**, the failure path resets `consumed_at = NULL` and flips the reservation to `released`, so a transient error leaves the confirmation re-approvable (rather than burning it). This refines Phase 4's `settleConfirmation`: the claim moves to *before* execution, and the failure path un-claims.

**(b) Allow-mode (`create_contact`) — idempotency_records.** No confirmation gates a repeat, so the auto-hash key (`sha256(canonical(args) || tenantId || tool)`) + `withIdempotency` is the dedup: first call executes + stores; a repeat within 10 min replays the stored result (`replayed: true`, no upstream call).

**Defense-in-depth:** confirm-mode results are ALSO written to `idempotency_records` keyed on the confirmation id, so a sequential retry after a committed success replays rather than erroring — but the atomic claim in (a) is the primary correctness guarantee. The invariant across both: **each billable/destructive upstream write fires at most once per (tenant, key).**

> **Where it lives:** `server.ts`'s `dispatchFactory`. Allow-mode tools get their handler wrapped with `withIdempotency(client, tenantId, autoHashKey, name, handler)`. Confirm-mode tools get the atomic claim wired into the consume / `confirm_pending` execution site (the claim replaces the bare `consumed_at` set, and the failure branch un-claims). The plan threads the exact call sites.

---

## 6. Approver workflow (exercised, not rebuilt)

No new code beyond the tools. The Phase 4 path already supports: an `operator` proposes `register_domain` → `confirmation_required`; an `owner`/`admin` calls `confirm_pending(confirmation_id, args)` → the stored confirmation's tool (`register_domain`) executes the real client call → reservation commits. Phase 5 adds the real tool and an e2e proving the full chain against Nock.

---

## 7. Error handling

Reuses the existing structured codes. New surfacing:
- A write whose tenant has no Openprovider account → `openprovider_not_connected` (Phase 3 error, already wired via `fetchCredentials`).
- Upstream 4xx on a write (e.g., domain taken, invalid handle) → `upstream_error` with sanitized `details.upstream_status` (no raw upstream body on the wire).
- Replay → normal success result with `replayed: true`; never an error.

---

## 8. Testing

**Unit (Nock + vi):**
- Each client write method: success (200/201), 401 → `OpenproviderAuthError`, 4xx → `OpenproviderClientError`, 5xx → retry then `OpenproviderUnavailableError`. `X-Idempotency-Key` header sent when provided.
- Each tool factory: token fetched, correct client method called with parsed args.
- Strict contact schemas: reject missing `last_name`, missing `phone.subscriber_number`, 3-letter country; assert **no mutation** (e.g., a `+91` number is passed through unchanged, role is not defaulted).
- `idempotencyKeyFor` (confirm id vs auto-hash, order-insensitive hash); `withIdempotency` (miss executes once + stores; hit replays without calling fn).

**Integration (testcontainers):**
- `idempotency_records` RLS isolation; `withIdempotency` against real PG: first call executes + stores, second within window replays (fn called once), expired row re-executes.
- **Confirm-mode claim:** two concurrent `confirm_pending` calls on the same confirmation id → the atomic `UPDATE … WHERE consumed_at IS NULL RETURNING` lets exactly one claim succeed; the other gets `confirmation_not_found`; the upstream write fires exactly once. (The marquee concurrency test for Phase 5.)

**E2E (Nock upstream):**
- Operator proposes `register_domain` (cap raised) → owner `confirm_pending` → exactly one Nock `POST /domains` fires → reservation committed.
- Replay: `create_contact` called twice with identical args → exactly one Nock `POST /contacts` → second call returns the stored result (`replayed: true`).
- Spend-cap denial: over-budget `register_domain` propose → `policy_denied`.

**Live sandbox (opt-in nightly, env-gated):**
- `create_contact` → `get_contact` → `update_contact` → `delete_contact` round-trip against the real Openprovider sandbox. **No `register_domain` against live, ever.**

---

## 9. File structure

| File | Responsibility |
|---|---|
| `src/openprovider/types.ts` (mod) | RegisterDomain/UpdateDomain/CreateContact/UpdateContact arg schemas |
| `src/openprovider/client.ts` (mod) | 5 write methods + optional idempotency header |
| `migrations/0009_idempotency_records.sql` (new) | idempotency table + RLS |
| `src/db/schema.ts` (mod) | `idempotencyRecords` mirror |
| `src/policies/idempotency.ts` (new) | `idempotencyKeyFor`, `withIdempotency` |
| `src/tools/{register-domain,update-domain,create-contact,update-contact,delete-contact}.ts` (new) | tool factories |
| `src/server.ts` (mod) | register the 5 tools; wrap write handlers with `withIdempotency` |
| `scripts/...` | none new |
| `tests/...` | unit + integration + e2e + opt-in live-sandbox per §8 |

---

## 10. Out of scope (later phases)

- Dashboard (Phase 6); API keys; SSO.
- pg-boss workers (Phase 7).
- Domain transfer / trade / renew / restore / authcode; SSL, DNS, Spam Experts, Licenses, EasyDmarc, etc. (the other ~90 Postman endpoints) — future phases or explicit non-goals.
- Relying on Openprovider-side idempotency.

---

*End of spec.*

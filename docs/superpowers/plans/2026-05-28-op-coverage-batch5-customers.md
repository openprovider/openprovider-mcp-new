# OP Coverage Batch 5 — Customers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the 5 customer Openprovider tools to the MCP, following the Batch-1/2/3/4 tool pattern.

**Architecture:** Same per-tool pattern as prior batches. 2 reads (covered by `list_*`/`get_*` wildcards), 2 allow-writes, 1 confirm.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, fetch-based client, Postgres, Vitest + Nock + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-28-openprovider-full-api-coverage-design.md` (§3 Batch 5). **Branch:** `feat/enterprise-phase-1`.

---

## Spec deviation
The spec lists 6 customer tools including `get_deleted_customer`, but the Postman collection entry for that name is NOT a distinct endpoint — it's a negative-path test against `GET /customers/:handle` on an already-deleted handle (expects HTTP 500). The Openprovider API does NOT expose a separate path or query flag for retrieving deleted customers. We implement **5 tools** (`list_customers`, `get_customer`, `create_customer`, `update_customer`, `delete_customer`) instead of 6.

## Endpoint reference (exact, from Postman collection)
All identifiers are **customer handles** (strings like `JD123456-NL`), NOT numeric IDs. Field names are **snake_case**.

| tool | method | path | body | mode |
|---|---|---|---|---|
| `list_customers` | GET | `/customers` | — | R |
| `get_customer` | GET | `/customers/:handle` | — | R |
| `create_customer` | POST | `/customers` | nested customer body | A |
| `update_customer` | PUT | `/customers/:handle` | partial customer body | A |
| `delete_customer` | DELETE | `/customers/:handle` | — | C |

**Customer body structure** (nested objects):
- `name`: `{ first_name, last_name, full_name?, initials?, prefix? }` (first/last required)
- `address`: `{ street, number, city, zipcode, state?, country, suffix? }` (street/number/city/zipcode/country required)
- `phone`: `{ country_code, area_code, subscriber_number }` (all required)
- `fax`: `{ country_code?, area_code?, subscriber_number? }` (optional whole object)
- `email`: required string
- `username`: required string (CREATE only — not updatable)
- `tags`: `[{ key, value }]` (optional array)
- `additional_data`: optional object (registry-specific extras — passthrough)
- `extension_additional_data`: optional `[{ name, data }]` (registry extensions — passthrough)
- `company_name`, `comments`, `locale`, `vat`: optional top-level strings

For the schema we'll define a strict `CustomerBody` (for create) with `username` required, and `UpdateCustomerArgs` that omits `username` and makes everything else optional (partial update).

**Catalog count:** 65 (after Batch 4) → **70**.

**Modes to ADD to `DEFAULT_POLICY.tools` + migration 0018 (3 explicit entries; reads are wildcards):**
- `create_customer`: allow
- `update_customer`: allow
- `delete_customer`: confirm

**Client contract (established):** arg-methods `(token, args)` with `.parse()` inside; path derived from a parsed field for updates. Path-only methods take `(token, handle: string)` with `encodeURIComponent`.

---

## Task 1: DEFAULT_POLICY modes + migration 0018

**Files:** Modify `src/policies/schema.ts`; Create `migrations/0018_customers_policy.sql`; Modify `migrations/meta/_journal.json`; Test `tests/integration/db/customers-policy.test.ts`.

- [ ] **Step 1: Append 3 modes** to `DEFAULT_POLICY.tools` (after Batch-4 SSL entries):
```ts
    create_customer: 'allow',
    update_customer: 'allow',
    delete_customer: 'confirm',
```

- [ ] **Step 2: Write failing test** `tests/integration/db/customers-policy.test.ts` mirroring `tests/integration/db/ssl-policy.test.ts`. Email `b5-customers-policy@example.com`. Assert all 3 new modes.

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Create `migrations/0018_customers_policy.sql`** by copying `migrations/0017_ssl_policy.sql` VERBATIM, changing ONLY the `tools` object in the inserted doc JSON to ALSO include 3 new customer keys:
```
,"create_customer":"allow","update_customer":"allow","delete_customer":"confirm"
```
Journal entry: idx 17, tag `0018_customers_policy`.

- [ ] **Step 5: Run → pass.** Typecheck.
- [ ] **Step 6: Commit** `git add src/policies/schema.ts migrations/0018_customers_policy.sql migrations/meta/_journal.json tests/integration/db/customers-policy.test.ts && git commit -m "feat(op-batch5): default-policy modes for customer tools (migration 0018)"`.

---

## Task 2: zod schemas

**Files:** Modify `src/openprovider/types.ts`; Test `src/openprovider/types.test.ts` (append).

Add a shared `CustomerBody` (used by create) + path-arg + update schema:
```ts
const CustomerName = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  full_name: z.string().optional(),
  initials: z.string().optional(),
  prefix: z.string().optional(),
});
const CustomerAddress = z.object({
  street: z.string().min(1),
  number: z.string().min(1),
  city: z.string().min(1),
  zipcode: z.string().min(1),
  state: z.string().optional(),
  country: z.string().min(2).max(2),
  suffix: z.string().optional(),
});
const CustomerPhone = z.object({
  country_code: z.string().min(1),
  area_code: z.string().min(1),
  subscriber_number: z.string().min(1),
});
const CustomerFax = z.object({
  country_code: z.string().optional(),
  area_code: z.string().optional(),
  subscriber_number: z.string().optional(),
});
const CustomerTag = z.object({ key: z.string(), value: z.string() });

export const CustomerHandleArg = z.object({ handle: z.string().min(1) });

export const CreateCustomerArgs = z.object({
  email: z.string().min(1),
  username: z.string().min(1),
  name: CustomerName,
  address: CustomerAddress,
  phone: CustomerPhone,
  fax: CustomerFax.optional(),
  tags: z.array(CustomerTag).optional(),
  company_name: z.string().optional(),
  comments: z.string().optional(),
  locale: z.string().optional(),
  vat: z.string().optional(),
  additional_data: z.record(z.string(), z.unknown()).optional(),
  extension_additional_data: z.array(z.object({ name: z.string(), data: z.record(z.string(), z.unknown()) })).optional(),
});

// Update: handle in path, body is partial; `username` is NOT updatable so omit it
export const UpdateCustomerArgs = z.object({
  handle: z.string().min(1),
  email: z.string().min(1).optional(),
  name: CustomerName.partial().optional(),
  address: CustomerAddress.partial().optional(),
  phone: CustomerPhone.partial().optional(),
  fax: CustomerFax.optional(),
  tags: z.array(CustomerTag).optional(),
  company_name: z.string().optional(),
  comments: z.string().optional(),
  locale: z.string().optional(),
  vat: z.string().optional(),
  additional_data: z.record(z.string(), z.unknown()).optional(),
  extension_additional_data: z.array(z.object({ name: z.string(), data: z.record(z.string(), z.unknown()) })).optional(),
});
```

- [ ] **Step 1: Write failing schema tests** for `CustomerHandleArg`, `CreateCustomerArgs`, `UpdateCustomerArgs` — positive + negative cases. Confirm: create requires email/username/full name/full address/phone; update accepts `{ handle }` alone (everything else optional).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Add schemas + `export type Xxx = z.infer<typeof Xxx>` for each export.**
- [ ] **Step 4: Run → pass.** Typecheck.
- [ ] **Step 5: Commit** `git add src/openprovider/types.ts src/openprovider/types.test.ts && git commit -m "feat(op-batch5): zod schemas for customer tools"`.

---

## Task 3: `OpenproviderClient` methods + Nock tests + mock cascade

**Files:** Modify `src/openprovider/client.ts` (+ interface); Test `src/openprovider/client.test.ts`; mock-cascade fixes (4 files).

The 5 methods:
```ts
listCustomers(token): Promise<unknown>                        // GET /customers
getCustomer(token, handle: string)                            // GET /customers/${encodeURIComponent(handle)}
createCustomer(token, args: CreateCustomerArgs)               // POST /customers, body = parsed
updateCustomer(token, args: UpdateCustomerArgs)               // PUT /customers/${encodeURIComponent(parsed.handle)}, body = parsed
deleteCustomer(token, handle: string)                         // DELETE /customers/${encodeURIComponent(handle)}
```

All unwrap `(b as { data?: unknown }).data ?? b`. Arg-methods call `.parse()`. String path params `encodeURIComponent`-encoded.

- [ ] **Step 1: Add failing Nock tests** for all 5 (body matchers on create/update asserting `email`/`name.first_name`/`address.street` etc.).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** 5 methods + interface signatures. Import the 2 new arg types from `./types.js`.
- [ ] **Step 4: Run + fix mock cascade.** Add `vi.fn()` stubs for all 5 to: `src/policies/pricing.test.ts` (`clientWith`), `src/tools/check-domain.test.ts`, `src/tools/read-tools.test.ts`, `src/tools/write-tools.test.ts`. Re-run typecheck (0) + `npx vitest run` (full unit green).
- [ ] **Step 5: Commit** including the cascade fixes: `git commit -m "feat(op-batch5): OpenproviderClient customer methods"`.

---

## Task 4: Tool factories (5) + catalog + dispatch

**Files:** Create 5 factories; Modify `tool-catalog.ts`, `server.ts`, `tool-catalog.test.ts`.

| tool name | factory | schema | client call | description |
|---|---|---|---|---|
| `list_customers` | `createListCustomersTool` | `NoArgs` | `listCustomers(token)` | "List customers." |
| `get_customer` | `createGetCustomerTool` | `CustomerHandleArg` | `getCustomer(token, parsed.handle)` | "Get customer details by handle." |
| `create_customer` | `createCreateCustomerTool` | `CreateCustomerArgs` | `createCustomer(token, parsed)` | "Create a customer (contact)." |
| `update_customer` | `createUpdateCustomerTool` | `UpdateCustomerArgs` | `updateCustomer(token, parsed)` | "Update a customer (contact)." |
| `delete_customer` | `createDeleteCustomerTool` | `CustomerHandleArg` | `deleteCustomer(token, parsed.handle)` | "Delete a customer (requires approval)." |

- [ ] **Step 1: Create the 5 factory files** (~20 lines each, mirror Batch-4 exemplars).
- [ ] **Step 2: Register** all 5 in `buildToolCatalog` (stub deps) and `dispatchFactory` (real deps).
- [ ] **Step 3: Update catalog test:** add 5 names; count 65 → 70.
- [ ] **Step 4: Verify** typecheck (0); catalog test green; full unit suite green.
- [ ] **Step 5: Commit** all 9 files: `git commit -m "feat(op-batch5): customer tools (list/get/create/update/delete)"`.

---

## Task 5: Integration test + full gate + commit

**Files:** Create `tests/integration/mcp/customers-e2e.test.ts`.

Model on `tests/integration/mcp/ssl-e2e.test.ts`. With NO OP creds:

1. `tools/list` includes the 5 new names.
2. Operator calling `list_customers {}` → `openprovider_not_connected`.
3. Operator calling `create_customer` with valid minimum body → `openprovider_not_connected` (allow, no confirm). Use minimum: `{ email:'a@b.c', username:'usr', name:{first_name:'F', last_name:'L'}, address:{street:'St', number:'1', city:'C', zipcode:'Z', country:'NL'}, phone:{country_code:'+1', area_code:'555', subscriber_number:'1234567'} }`.
4. Operator calling `delete_customer { handle: 'X' }` → confirmation-proposal shape (NOT executed).
5. Viewer calling `delete_customer` → `policy_denied`; viewer calling `create_customer` → `policy_denied`; viewer calling `list_customers {}` (read) → `openprovider_not_connected`.

- [ ] **Step 1: Write the test** using the exact harness from `ssl-e2e.test.ts`.
- [ ] **Step 2: Run → pass** integration test.
- [ ] **Step 3: FULL gate** — typecheck (0), lint (0), unit green, integration green (live skips OK; `audit-chain` may flake under parallel load — re-run in isolation to confirm pre-existing). Catalog test = 70.
- [ ] **Step 4: Commit + STOP** (do NOT push): `git add tests/integration/mcp/customers-e2e.test.ts && git commit -m "test(op-batch5): customers dispatch + policy integration"`.

---

## Self-Review
**Spec coverage:** All 5 customer tools (2 reads, 2 allow-writes, 1 delete) → Task 4; policy → Task 1; schemas → Task 2; client → Task 3; integration → Task 5. **Documented deviation:** `get_deleted_customer` skipped (no distinct OP endpoint). **Type consistency:** schema names match across tasks; catalog grows 65 → 70. ✅

*End of plan.*

# OP Coverage Batch 7 — License Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the 9 license Openprovider tools (license catalog + Plesk licenses) to the MCP. This is the **final batch** of the full-API-coverage effort.

**Architecture:** Same per-tool pattern as prior batches. 5 reads (covered by `list_*`/`get_*` wildcards), 2 allow-writes, 2 confirms (1 billable, 1 destructive).

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, fetch-based client, Postgres, Vitest + Nock + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-28-openprovider-full-api-coverage-design.md` (§3 Batch 7). **Branch:** `feat/enterprise-phase-1`.

---

## Endpoint reference (exact, from Postman collection)

All identifiers (`key_id`) are **numeric integers**. Field names are **snake_case**.

| tool | method | path | body | mode |
|---|---|---|---|---|
| `list_license_prices` | GET | `/licenses` | — | R |
| `list_license_items` | GET | `/licenses/items` | — | R |
| `list_plesk_licenses` | GET | `/licenses/plesk` | — | R |
| `get_plesk_license` | GET | `/licenses/plesk/:key_id` | — | R |
| `get_plesk_key` | GET | `/licenses/plesk/key/:key_id` | — | R |
| `create_plesk_license` | POST | `/licenses/plesk` | `{ items, period, ip_address_binding, title, attached_keys?, comment?, parent_key_id?, restrict_ip_binding? }` | C (billable, confirm-without-spend) |
| `update_plesk_license` | PUT | `/licenses/plesk/:key_id` | same body as create | A |
| `reset_plesk_hwid` | POST | `/licenses/hwids/reset/:product/:key_id` | `{ key_id, product }` | A |
| `delete_plesk_license` | DELETE | `/licenses/plesk/:key_id` | — | C (destructive) |

**Notable shape notes:**
- `get_plesk_key` path is `/licenses/plesk/key/:key_id` — literal segment `key` BEFORE the id, NOT `/:id/key`.
- `reset_plesk_hwid` path is `/licenses/hwids/reset/:product/:key_id` — generic hwid endpoint (not Plesk-specific in path). Body redundantly includes `key_id` + `product`. Tool name does NOT have a read prefix, so it's policy-controlled (we map it explicit `allow`).
- `create_plesk_license` body required fields: `items` (string array of SKUs e.g. `"PLESK-12-VPS-WEB-ADMIN-1M"`), `period` (months int), `ip_address_binding` (IP string), `title` (string). Optional: `attached_keys` (array, default `[]`), `comment` (string), `parent_key_id` (number, 0 = no parent), `restrict_ip_binding` (bool).
- `update_plesk_license` body same as create.
- `create_plesk_license` is **billable** but, like Batches 1 & 4 billable tools, mapped to `confirm` without spend-cap integration (deferred until pricing.ts integration). Owner/admin approval is the control.

**Catalog count:** 88 (after Batch 6) → **97**.

**Modes to ADD to `DEFAULT_POLICY.tools` + migration 0020 (4 explicit entries; reads are wildcards):**
- `create_plesk_license`: confirm
- `update_plesk_license`: allow
- `reset_plesk_hwid`: allow
- `delete_plesk_license`: confirm

**Client contract (established):** arg-methods `(token, args)` with `.parse()` inside; path-only methods take `(token, id: number)` or `(token, product: string, id: number)`; string path params `encodeURIComponent`-encoded; numeric ids interpolated directly.

---

## Task 1: DEFAULT_POLICY modes + migration 0020

**Files:** Modify `src/policies/schema.ts`; Create `migrations/0020_license_policy.sql`; Modify `migrations/meta/_journal.json`; Test `tests/integration/db/license-policy.test.ts`.

- [ ] **Step 1: Append 4 modes** to `DEFAULT_POLICY.tools` (after Batch-6 email entries):
```ts
    create_plesk_license: 'confirm',
    update_plesk_license: 'allow',
    reset_plesk_hwid: 'allow',
    delete_plesk_license: 'confirm',
```

- [ ] **Step 2: Failing migration test** `tests/integration/db/license-policy.test.ts` mirroring `tests/integration/db/email-policy.test.ts`. Email `b7-license-policy@example.com`. Assert all 4 new modes.

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Create `migrations/0020_license_policy.sql`** by copying `migrations/0019_email_policy.sql` VERBATIM, appending 4 new keys to the `tools` JSON before the closing brace:
```
,"create_plesk_license":"confirm","update_plesk_license":"allow","reset_plesk_hwid":"allow","delete_plesk_license":"confirm"
```
Journal entry idx 19, tag `0020_license_policy`.

- [ ] **Step 5: Run → pass.** Typecheck.
- [ ] **Step 6: Commit** `git commit -m "feat(op-batch7): default-policy modes for license tools (migration 0020)"`.

---

## Task 2: zod schemas

**Files:** Modify `src/openprovider/types.ts`; Test `src/openprovider/types.test.ts` (append).

Add:
```ts
// path-arg
export const PleskKeyIdArg = z.object({ key_id: z.number().int().positive() });

// shared Plesk license body (create + update)
const PleskLicenseBody = z.object({
  items: z.array(z.string().min(1)).min(1),
  period: z.number().int().positive(),
  ip_address_binding: z.string().min(1),
  title: z.string().min(1),
  attached_keys: z.array(z.unknown()).optional(),
  comment: z.string().optional(),
  parent_key_id: z.number().int().nonnegative().optional(),
  restrict_ip_binding: z.boolean().optional(),
});
export const CreatePleskLicenseArgs = PleskLicenseBody;
export const UpdatePleskLicenseArgs = PleskLicenseBody.extend({ key_id: z.number().int().positive() });

// HWID reset
export const ResetPleskHwidArgs = z.object({
  key_id: z.number().int().positive(),
  product: z.string().min(1),
});
```
File-private helper: `PleskLicenseBody`. 4 exported schemas + 4 `export type Xxx = z.infer<typeof Xxx>`.

- [ ] **Step 1: Failing tests** — positive + negative for each schema.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Add schemas.**
- [ ] **Step 4: Run → pass.** Typecheck.
- [ ] **Step 5: Commit** `git commit -m "feat(op-batch7): zod schemas for license tools"`.

---

## Task 3: `OpenproviderClient` methods + Nock tests + mock cascade

**Files:** Modify `src/openprovider/client.ts` (+ interface); Test `src/openprovider/client.test.ts`; cascade fixes in `pricing.test.ts`, `check-domain.test.ts`, `read-tools.test.ts`, `write-tools.test.ts`.

The 9 methods:
```ts
// reads
listLicensePrices(token): Promise<unknown>                      // GET /licenses
listLicenseItems(token)                                          // GET /licenses/items
listPleskLicenses(token)                                         // GET /licenses/plesk
getPleskLicense(token, keyId: number)                            // GET /licenses/plesk/${keyId}
getPleskKey(token, keyId: number)                                // GET /licenses/plesk/key/${keyId}

// writes
createPleskLicense(token, args: CreatePleskLicenseArgs)          // POST /licenses/plesk, body = parsed
updatePleskLicense(token, args: UpdatePleskLicenseArgs)          // PUT /licenses/plesk/${parsed.key_id}, body = parsed
resetPleskHwid(token, args: ResetPleskHwidArgs)                  // POST /licenses/hwids/reset/${encodeURIComponent(parsed.product)}/${parsed.key_id}, body = parsed
deletePleskLicense(token, keyId: number)                         // DELETE /licenses/plesk/${keyId}
```
All unwrap. Arg-methods call `.parse()`. Numeric ids interpolated directly. `product` (string) is `encodeURIComponent`-encoded.

- [ ] **Step 1: Failing Nock tests** for all 9 (body matchers on writes).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** 9 methods + interface signatures. Import 3 arg types from `./types.js`.
- [ ] **Step 4: Run + fix mock cascade.** Add `vi.fn()` stubs for all 9 to the 4 mock-client files. Typecheck (0) + full unit green.
- [ ] **Step 5: Commit** including cascade fixes: `git commit -m "feat(op-batch7): OpenproviderClient license methods"`.

---

## Task 4: Tool factories (9) + catalog + dispatch

**Files:** Create 9 factories; Modify `tool-catalog.ts`, `server.ts`, `tool-catalog.test.ts`.

| tool name | factory | schema | client call | description |
|---|---|---|---|---|
| `list_license_prices` | `createListLicensePricesTool` | `NoArgs` | `listLicensePrices(token)` | "List licenses with pricing." |
| `list_license_items` | `createListLicenseItemsTool` | `NoArgs` | `listLicenseItems(token)` | "List license catalog items (SKUs)." |
| `list_plesk_licenses` | `createListPleskLicensesTool` | `NoArgs` | `listPleskLicenses(token)` | "List provisioned Plesk licenses." |
| `get_plesk_license` | `createGetPleskLicenseTool` | `PleskKeyIdArg` | `getPleskLicense(token, parsed.key_id)` | "Get a Plesk license by key id." |
| `get_plesk_key` | `createGetPleskKeyTool` | `PleskKeyIdArg` | `getPleskKey(token, parsed.key_id)` | "Get the Plesk activation key for a license." |
| `create_plesk_license` | `createCreatePleskLicenseTool` | `CreatePleskLicenseArgs` | `createPleskLicense(token, parsed)` | "Provision a new Plesk license (billable; requires approval)." |
| `update_plesk_license` | `createUpdatePleskLicenseTool` | `UpdatePleskLicenseArgs` | `updatePleskLicense(token, parsed)` | "Update a Plesk license." |
| `reset_plesk_hwid` | `createResetPleskHwidTool` | `ResetPleskHwidArgs` | `resetPleskHwid(token, parsed)` | "Reset the HWID binding of a Plesk license." |
| `delete_plesk_license` | `createDeletePleskLicenseTool` | `PleskKeyIdArg` | `deletePleskLicense(token, parsed.key_id)` | "Delete a Plesk license (requires approval)." |

NO confirm logic in factories.

- [ ] **Step 1: Create the 9 factory files** (~20 lines each).
- [ ] **Step 2: Register** all 9 in `buildToolCatalog` (stub deps) and `dispatchFactory` (real deps).
- [ ] **Step 3: Update catalog test** — add 9 names; count 88 → 97.
- [ ] **Step 4: Verify** typecheck (0); catalog test green; full unit green.
- [ ] **Step 5: Commit** all 12 files: `git commit -m "feat(op-batch7): license tools (catalog/plesk lifecycle/hwid)"`.

---

## Task 5: Integration test + full gate + commit

**Files:** Create `tests/integration/mcp/license-e2e.test.ts`.

Model on `tests/integration/mcp/email-e2e.test.ts`. With NO OP creds, assert:

1. **tools/list includes all 9 names**.
2. **Allow read reaches handler**: operator → `list_license_items {}` → `openprovider_not_connected`; operator → `get_plesk_license { key_id: 1 }` → `openprovider_not_connected`.
3. **Allow write reaches handler**: operator → `reset_plesk_hwid { key_id: 1, product: 'plesk' }` → `openprovider_not_connected`; operator → `update_plesk_license { key_id: 1, items: ['SKU'], period: 1, ip_address_binding: '127.0.0.1', title: 'T' }` → `openprovider_not_connected`.
4. **Confirm short-circuits**: operator → `create_plesk_license { items: ['SKU'], period: 1, ip_address_binding: '127.0.0.1', title: 'T' }` → proposal shape; operator → `delete_plesk_license { key_id: 1 }` → proposal shape (NOT executed).
5. **Viewer gate**: viewer → `delete_plesk_license` → `policy_denied`; viewer → `create_plesk_license` → `policy_denied`; viewer → `reset_plesk_hwid` → `policy_denied`; viewer → `list_license_items {}` (read) → `openprovider_not_connected`.

- [ ] **Step 1: Write the test.**
- [ ] **Step 2: Run → pass** integration test.
- [ ] **Step 3: FULL gate** — typecheck (0), lint (0), unit green, integration green (live skips OK; `audit-chain` flake may need isolation re-run). Catalog test = 97.
- [ ] **Step 4: Commit + STOP** (do NOT push): `git add tests/integration/mcp/license-e2e.test.ts && git commit -m "test(op-batch7): license dispatch + policy integration"`.

---

## Self-Review
**Spec coverage:** All 9 license tools (5 reads, 2 allow-writes, 2 confirms) → Task 4; policy → Task 1; schemas → Task 2; client → Task 3; integration → Task 5. ✅
**Type consistency:** `PleskKeyIdArg`/`CreatePleskLicenseArgs`/`UpdatePleskLicenseArgs`/`ResetPleskHwidArgs` match across Tasks 2→3→4. Catalog grows 88 → 97. ✅
**Billable note:** `create_plesk_license` is `confirm`-mode (owner/admin approval). Pricing-engine integration deferred (same accepted fallback as Batch 1/4 billables).

*End of plan — this is the final batch of the full-API-coverage effort.*

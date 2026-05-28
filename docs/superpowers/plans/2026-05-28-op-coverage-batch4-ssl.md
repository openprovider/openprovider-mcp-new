# OP Coverage Batch 4 — SSL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the 15 SSL Openprovider tools (products, orders lifecycle, CSR, approver emails, OTP) to the MCP, following the Batch-1/2/3 tool pattern.

**Architecture:** Same per-tool pattern as prior batches. 5 reads (covered by `list_*`/`get_*` allow wildcards), 6 allow-writes, 4 confirms (3 billable + 1 destructive). Billable confirm tools are **confirm-without-spend** in this batch (pricing.ts integration deferred — same accepted fallback as Batch 1).

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, fetch-based client, Postgres, Vitest + Nock + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-28-openprovider-full-api-coverage-design.md` (§3 Batch 4). **Branch:** `feat/enterprise-phase-1`.

---

## Endpoint reference (exact, from Postman collection)

All IDs are **numeric integers**. Field names are **snake_case**.

| tool | method | path | body | mode |
|---|---|---|---|---|
| `list_ssl_products` | GET | `/ssl/products` | — | R |
| `get_ssl_product` | GET | `/ssl/products/:id` | — | R |
| `list_ssl_orders` | GET | `/ssl/orders` | — | R |
| `get_ssl_order` | GET | `/ssl/orders/:id` | — | R |
| `get_ssl_approver_emails` | GET | `/ssl/approver-emails?domain=...` | — | R |
| `create_ssl_order` | POST | `/ssl/orders` | full order body | C (billable, confirm-without-spend) |
| `renew_ssl_order` | POST | `/ssl/orders/:id/renew` | `{ id, enable_dns_automation }` | C (billable, confirm-without-spend) |
| `reissue_ssl_order` | POST | `/ssl/orders/:id/reissue` | full order body | C (billable, confirm-without-spend) |
| `cancel_ssl_order` | POST | `/ssl/orders/:id/cancel` | `{ id }` | C (destructive) |
| `update_ssl_order` | PUT | `/ssl/orders/:id` | full order body | A |
| `update_ssl_approver_email` | PUT | `/ssl/orders/:id/approver-email` | `{ id, approver_email }` | A |
| `resend_ssl_approver_email` | POST | `/ssl/orders/:id/approver-email/resend` | `{ id }` | A |
| `create_csr` | POST | `/ssl/csr` | CSR generation body | A |
| `decode_csr` | POST | `/ssl/csr/decode` | `{ csr }` | A |
| `create_ssl_otp_token` | POST | `/ssl/orders/:id/otp-tokens` | `{ id }` | A |

**Full SSL order body** (used by create/update/reissue):
- Required: `approver_email`, `autorenew` (enum `on|off`), `csr`, `domain_amount`, `domain_validation_methods[]` (each `{ host_name, method }`), `enable_dns_automation` (bool), `host_names[]`, `organization_handle`, `period`, `product_id`, `signature_hash_algorithm`, `software_id`, `start_provision`, `technical_handle`, `wildcard_domain_amount`. Optional: none enforced strictly (mirror Postman example).

**Catalog count:** 50 (after Batch 3) → **65**.

**Modes to ADD to `DEFAULT_POLICY.tools` + migration 0017 (10 explicit entries; the 5 reads are wildcards):**
- `create_ssl_order`: confirm
- `renew_ssl_order`: confirm
- `reissue_ssl_order`: confirm
- `cancel_ssl_order`: confirm
- `update_ssl_order`: allow
- `update_ssl_approver_email`: allow
- `resend_ssl_approver_email`: allow
- `create_csr`: allow
- `decode_csr`: allow
- `create_ssl_otp_token`: allow

**Client contract (established):** arg-methods `(token, args)`, `.parse()` inside, path derived from a parsed field for updates. Path-only methods take `(token, id: number)` since all SSL ids are numeric.

**Note:** Confirm-without-spend for the 3 billable tools (`create/renew/reissue_ssl_order`) — pricing.ts integration is deferred (same approach as Batch 1 billables; future task).

---

## Task 1: DEFAULT_POLICY modes + migration 0017

**Files:** Modify `src/policies/schema.ts`; Create `migrations/0017_ssl_policy.sql`; Modify `migrations/meta/_journal.json`; Test `tests/integration/db/ssl-policy.test.ts`.

- [ ] **Step 1: Append 10 explicit modes to `DEFAULT_POLICY.tools` in `src/policies/schema.ts`** (after the Batch-3 entries):
```ts
    create_ssl_order: 'confirm',
    renew_ssl_order: 'confirm',
    reissue_ssl_order: 'confirm',
    cancel_ssl_order: 'confirm',
    update_ssl_order: 'allow',
    update_ssl_approver_email: 'allow',
    resend_ssl_approver_email: 'allow',
    create_csr: 'allow',
    decode_csr: 'allow',
    create_ssl_otp_token: 'allow',
```

- [ ] **Step 2: Write failing migration test** `tests/integration/db/ssl-policy.test.ts` mirroring `tests/integration/db/tags-policy.test.ts`. Assert the 4 confirm modes + 2 representative allow modes (`create_ssl_order=confirm`, `cancel_ssl_order=confirm`, `update_ssl_order=allow`, `create_csr=allow`). Use email `b4-ssl-policy@example.com`.

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Create `migrations/0017_ssl_policy.sql`** by copying `migrations/0016_tags_policy.sql` VERBATIM, changing ONLY the `tools` object in the inserted doc JSON to ALSO include the 10 new SSL keys appended at the end (before the closing brace):
```
,"create_ssl_order":"confirm","renew_ssl_order":"confirm","reissue_ssl_order":"confirm","cancel_ssl_order":"confirm","update_ssl_order":"allow","update_ssl_approver_email":"allow","resend_ssl_approver_email":"allow","create_csr":"allow","decode_csr":"allow","create_ssl_otp_token":"allow"
```
Append journal entry idx 16, tag `0017_ssl_policy` (copy field shape from idx-15).

- [ ] **Step 5: Run → pass.** Typecheck.

- [ ] **Step 6: Commit** `git add src/policies/schema.ts migrations/0017_ssl_policy.sql migrations/meta/_journal.json tests/integration/db/ssl-policy.test.ts && git commit -m "feat(op-batch4): default-policy modes for SSL tools (migration 0017)"`.

---

## Task 2: zod schemas

**Files:** Modify `src/openprovider/types.ts`; Test `src/openprovider/types.test.ts` (append).

Define a shared `SslOrderBody` schema (reused by create/update/reissue) and the smaller per-tool schemas.

- [ ] **Step 1: Write failing schema tests** (append) — cover required-field validation for `SslOrderIdArg`, `SslProductIdArg`, `GetSslApproverEmailsArgs`, `CreateSslOrderArgs`, `UpdateSslOrderArgs`, `ReissueSslOrderArgs`, `RenewSslOrderArgs`, `CancelSslOrderArgs`, `UpdateSslApproverEmailArgs`, `ResendSslApproverEmailArgs`, `CreateCsrArgs`, `DecodeCsrArgs`, `CreateSslOtpTokenArgs`. Include negative cases (missing required fields).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Add schemas to `src/openprovider/types.ts`** (append after Batch-3 schemas):
```ts
// path-id args
export const SslOrderIdArg = z.object({ id: z.number().int().positive() });
export const SslProductIdArg = z.object({ id: z.number().int().positive() });

// query-arg
export const GetSslApproverEmailsArgs = z.object({ domain: z.string().min(1) });

// shared SSL order body (create/update/reissue all use the same shape)
const DomainValidationMethod = z.object({
  host_name: z.string().min(1),
  method: z.enum(['dns', 'email', 'http']),
});
const SslOrderBody = z.object({
  approver_email: z.string().min(1),
  autorenew: z.enum(['on', 'off']),
  csr: z.string().min(1),
  domain_amount: z.number().int().nonnegative(),
  domain_validation_methods: z.array(DomainValidationMethod).min(1),
  enable_dns_automation: z.boolean(),
  host_names: z.array(z.string().min(1)).min(1),
  organization_handle: z.string().min(1),
  period: z.number().int().positive(),
  product_id: z.number().int().positive(),
  signature_hash_algorithm: z.string().min(1),
  software_id: z.string().min(1),
  start_provision: z.boolean(),
  technical_handle: z.string().min(1),
  wildcard_domain_amount: z.number().int().nonnegative(),
});
export const CreateSslOrderArgs = SslOrderBody;
// Update/Reissue: require `id` (path) + the full order body. Cleanest: use extend.
export const UpdateSslOrderArgs = SslOrderBody.extend({ id: z.number().int().positive() });
export const ReissueSslOrderArgs = SslOrderBody.extend({ id: z.number().int().positive() });

// Renew (smaller body)
export const RenewSslOrderArgs = z.object({
  id: z.number().int().positive(),
  enable_dns_automation: z.boolean(),
});

// Cancel
export const CancelSslOrderArgs = z.object({ id: z.number().int().positive() });

// Approver email actions
export const UpdateSslApproverEmailArgs = z.object({
  id: z.number().int().positive(),
  approver_email: z.string().min(1),
});
export const ResendSslApproverEmailArgs = z.object({ id: z.number().int().positive() });

// CSR
export const CreateCsrArgs = z.object({
  bits: z.number().int().positive(),
  common_name: z.string().min(1),
  country: z.string().min(2).max(2),
  email: z.string().min(1),
  locality: z.string().min(1),
  organization: z.string().min(1),
  signature_hash_algorithm: z.string().min(1),
  state: z.string().min(1),
  subject_alternative_name: z.array(z.string()).optional(),
  unit: z.string().optional(),
  with_config: z.boolean().optional(),
});
export const DecodeCsrArgs = z.object({ csr: z.string().min(1) });

// OTP token
export const CreateSslOtpTokenArgs = z.object({ id: z.number().int().positive() });
```
Add `export type Xxx = z.infer<typeof Xxx>` for each exported schema.

- [ ] **Step 4: Run → pass.** Typecheck.
- [ ] **Step 5: Commit** `git add src/openprovider/types.ts src/openprovider/types.test.ts && git commit -m "feat(op-batch4): zod schemas for SSL tools"`.

---

## Task 3: `OpenproviderClient` methods + Nock tests + mock cascade

**Files:** Modify `src/openprovider/client.ts` (+ interface); Test `src/openprovider/client.test.ts` (append); cascade fixes in `src/policies/pricing.test.ts`, `src/tools/check-domain.test.ts`, `src/tools/read-tools.test.ts`, `src/tools/write-tools.test.ts`.

The 15 methods:

```ts
// reads
listSslProducts(token): Promise<unknown>                          // GET /ssl/products
getSslProduct(token, id: number)                                 // GET /ssl/products/:id
listSslOrders(token)                                              // GET /ssl/orders
getSslOrder(token, id: number)                                    // GET /ssl/orders/:id
getSslApproverEmails(token, args: GetSslApproverEmailsArgs)       // GET /ssl/approver-emails?domain=...

// allow-writes
updateSslOrder(token, args: UpdateSslOrderArgs)                   // PUT /ssl/orders/${parsed.id}, body = the body fields (parsed minus id is fine; or just send parsed — OP ignores extras)
updateSslApproverEmail(token, args: UpdateSslApproverEmailArgs)   // PUT /ssl/orders/${parsed.id}/approver-email, body = parsed
resendSslApproverEmail(token, args: ResendSslApproverEmailArgs)   // POST /ssl/orders/${parsed.id}/approver-email/resend, body = parsed
createCsr(token, args: CreateCsrArgs)                             // POST /ssl/csr, body = parsed
decodeCsr(token, args: DecodeCsrArgs)                             // POST /ssl/csr/decode, body = parsed
createSslOtpToken(token, args: CreateSslOtpTokenArgs)             // POST /ssl/orders/${parsed.id}/otp-tokens, body = parsed

// confirm
createSslOrder(token, args: CreateSslOrderArgs)                   // POST /ssl/orders, body = parsed
renewSslOrder(token, args: RenewSslOrderArgs)                     // POST /ssl/orders/${parsed.id}/renew, body = parsed
reissueSslOrder(token, args: ReissueSslOrderArgs)                 // POST /ssl/orders/${parsed.id}/reissue, body = parsed
cancelSslOrder(token, args: CancelSslOrderArgs)                   // POST /ssl/orders/${parsed.id}/cancel, body = parsed
```

All unwrap `(b as { data?: unknown }).data ?? b`. All arg-methods call `.parse()`. Numeric ids interpolated directly (no `encodeURIComponent`). For `getSslApproverEmails`, use `URLSearchParams({ domain: parsed.domain })` and append to path.

- [ ] **Step 1: Add failing Nock tests** for all 15 (mirror Batch-3 style; use `.query({...})` matcher for the approver-emails query; body matchers for the write methods asserting key fields).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement all 15** methods + interface signatures. Import all 13 arg types from `./types.js`.
- [ ] **Step 4: Run tests + fix mock cascade.** Add `vi.fn()` stubs for all 15 methods to: `src/policies/pricing.test.ts` `clientWith`, `src/tools/check-domain.test.ts`, `src/tools/read-tools.test.ts`, `src/tools/write-tools.test.ts`. Re-run typecheck (0) + full unit suite (green).
- [ ] **Step 5: Commit** `git add src/openprovider/client.ts src/openprovider/client.test.ts <mock test files> && git commit -m "feat(op-batch4): OpenproviderClient SSL methods"`.

---

## Task 4: Tool factories (15) + catalog + dispatch

**Files:** Create 15 files under `src/tools/`; Modify `src/mcp/tool-catalog.ts`, `src/server.ts`, `src/mcp/tool-catalog.test.ts`.

Each factory: `(deps) => ({ name, description, inputSchema, handler })` where handler does `const parsed = <Schema>.parse(args); const token = await deps.tokenManager.getToken(principal.tenantId); return deps.client.<method>(...);`.

| tool name | factory | schema | client method | description |
|---|---|---|---|---|
| `list_ssl_products` | `createListSslProductsTool` | `NoArgs` | `listSslProducts(token)` | "List available SSL products." |
| `get_ssl_product` | `createGetSslProductTool` | `SslProductIdArg` | `getSslProduct(token, parsed.id)` | "Get SSL product details by id." |
| `list_ssl_orders` | `createListSslOrdersTool` | `NoArgs` | `listSslOrders(token)` | "List SSL orders." |
| `get_ssl_order` | `createGetSslOrderTool` | `SslOrderIdArg` | `getSslOrder(token, parsed.id)` | "Get SSL order details by id." |
| `get_ssl_approver_emails` | `createGetSslApproverEmailsTool` | `GetSslApproverEmailsArgs` | `getSslApproverEmails(token, parsed)` | "List valid approver emails for a domain." |
| `update_ssl_order` | `createUpdateSslOrderTool` | `UpdateSslOrderArgs` | `updateSslOrder(token, parsed)` | "Update an SSL order." |
| `update_ssl_approver_email` | `createUpdateSslApproverEmailTool` | `UpdateSslApproverEmailArgs` | `updateSslApproverEmail(token, parsed)` | "Update the approver email of an SSL order." |
| `resend_ssl_approver_email` | `createResendSslApproverEmailTool` | `ResendSslApproverEmailArgs` | `resendSslApproverEmail(token, parsed)` | "Resend the approver email for an SSL order." |
| `create_csr` | `createCreateCsrTool` | `CreateCsrArgs` | `createCsr(token, parsed)` | "Generate a CSR." |
| `decode_csr` | `createDecodeCsrTool` | `DecodeCsrArgs` | `decodeCsr(token, parsed)` | "Decode a CSR." |
| `create_ssl_otp_token` | `createCreateSslOtpTokenTool` | `CreateSslOtpTokenArgs` | `createSslOtpToken(token, parsed)` | "Create an OTP token for an SSL order." |
| `create_ssl_order` | `createCreateSslOrderTool` | `CreateSslOrderArgs` | `createSslOrder(token, parsed)` | "Place an SSL order (billable; requires approval)." |
| `renew_ssl_order` | `createRenewSslOrderTool` | `RenewSslOrderArgs` | `renewSslOrder(token, parsed)` | "Renew an SSL order (billable; requires approval)." |
| `reissue_ssl_order` | `createReissueSslOrderTool` | `ReissueSslOrderArgs` | `reissueSslOrder(token, parsed)` | "Reissue an SSL order (billable; requires approval)." |
| `cancel_ssl_order` | `createCancelSslOrderTool` | `CancelSslOrderArgs` | `cancelSslOrder(token, parsed)` | "Cancel an SSL order (requires approval)." |

No confirm logic in factories — policy gates the 4 confirm tools.

- [ ] **Step 1: Create the 15 factory files.** Each ~20 lines, mirror `src/tools/list-tlds.ts` / `src/tools/create-tag.ts` / `src/tools/delete-tag.ts`.
- [ ] **Step 2: Register all 15** in `buildToolCatalog` (stub deps) and `dispatchFactory` (real deps `{ client: openproviderClient, tokenManager }`).
- [ ] **Step 3: Update `tool-catalog.test.ts`** — add 15 names, bump count 50 → 65.
- [ ] **Step 4: Verify** typecheck (0); catalog test green; full unit suite green.
- [ ] **Step 5: Commit** `git add src/tools/list-ssl-products.ts src/tools/get-ssl-product.ts src/tools/list-ssl-orders.ts src/tools/get-ssl-order.ts src/tools/get-ssl-approver-emails.ts src/tools/update-ssl-order.ts src/tools/update-ssl-approver-email.ts src/tools/resend-ssl-approver-email.ts src/tools/create-csr.ts src/tools/decode-csr.ts src/tools/create-ssl-otp-token.ts src/tools/create-ssl-order.ts src/tools/renew-ssl-order.ts src/tools/reissue-ssl-order.ts src/tools/cancel-ssl-order.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch4): SSL tools (15 — products/orders/CSR/approver/OTP)"`.

---

## Task 5: Integration test + full gate + commit

**Files:** Create `tests/integration/mcp/ssl-e2e.test.ts`.

Model on `tests/integration/mcp/catalog-tags-e2e.test.ts` (the latest harness). Seed a tenant; no OP creds. Assert:

1. **tools/list includes all 15 new names.**
2. **Allow read reaches handler:** `list_ssl_products` `{}` → `openprovider_not_connected`; `get_ssl_approver_emails { domain: 'x.com' }` → `openprovider_not_connected`.
3. **Allow write reaches handler:** `create_csr { bits:2048, common_name:'x.com', country:'NL', email:'a@b.c', locality:'Amsterdam', organization:'X', signature_hash_algorithm:'sha2', state:'NH' }` → `openprovider_not_connected`.
4. **Confirm short-circuits:** `cancel_ssl_order { id: 1 }` → proposal shape `{ confirmationId, confirmationToken, expiresAt, requiredApproverRoles }` (NOT executed).
5. **Viewer gate:** viewer→`cancel_ssl_order` → `policy_denied`; viewer→`create_csr` → `policy_denied`; viewer→`list_ssl_products` (read) → `openprovider_not_connected`.

- [ ] **Step 1: Write the test.**
- [ ] **Step 2: Run → pass** integration test.
- [ ] **Step 3: FULL gate** — typecheck (0), lint (0), unit + integration green. Catalog test count must equal 65.
- [ ] **Step 4: Commit + STOP** (do NOT push): `git add tests/integration/mcp/ssl-e2e.test.ts && git commit -m "test(op-batch4): SSL dispatch + policy integration"`.

---

## Self-Review
**Spec coverage:** All 15 SSL tools (5 reads, 6 allow-writes, 4 confirms) → Task 4; policy → Task 1; schemas → Task 2; client → Task 3; integration → Task 5. ✅ Billable tools (`create/renew/reissue_ssl_order`) are `confirm` — confirm-without-spend per the accepted deviation. **Placeholder scan:** none. **Type consistency:** schema names match across tasks; client method names match factories; catalog grows 50 → 65. ✅

*End of plan.*

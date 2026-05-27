# OP Coverage Batch 1 — Domain Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the 11 domain-lifecycle Openprovider tools (renew/transfer/trade/restore/delete/restart/approve-transfer/send-foa1/suggest/authcode get+reset) to the MCP, following the existing tool pattern, and make the read-tool classification prefix-based.

**Architecture:** Each tool = a zod schema (`types.ts`) + an `OpenproviderClient` method + a `src/tools/*.ts` factory, registered in `buildToolCatalog` (catalog/`tools/list`) and the per-request `dispatchFactory` (`server.ts`), with a `DEFAULT_POLICY` mode (read→allow, low-risk write→allow, delete/destructive + billable→confirm). `isReadTool` becomes prefix-based so new `get_`/`suggest_` reads are viewer-accessible. Billable ops (renew/transfer/trade/restore) are **confirm-without-spend** in this batch — accurate spend-capping awaits the Domain Price Service (Batch 3); the owner/admin confirmation gate is the control.

**Tech Stack:** TypeScript, zod, `OpenproviderClient` (fetch + retry/circuit-breaker), Postgres (DEFAULT_POLICY in `signup_tenant` migration + `schema.ts`), Vitest + Nock + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-28-openprovider-full-api-coverage-design.md` (§3 Batch 1).
**Branch:** `feat/enterprise-phase-1`.

---

## File Structure
| File | Change |
|---|---|
| `src/policies/engine.ts` | `isReadTool` → prefix-based; `evaluate` uses it. |
| `src/policies/schema.ts` | `DEFAULT_POLICY.tools`: add `check_*`/`suggest_*` wildcards + the 9 explicit new-tool modes. |
| `migrations/0014_domain_lifecycle_policy.sql` (+ journal idx 13) | `CREATE OR REPLACE signup_tenant` with the expanded default-policy JSON. |
| `src/openprovider/types.ts` | 11 new arg schemas. |
| `src/openprovider/client.ts` | 11 new methods (+ their interface signatures). |
| `src/tools/{suggest-domain,get-domain-authcode,reset-domain-authcode,approve-domain-transfer,send-foa1-domain-transfer,delete-domain,restart-domain-operation,renew-domain,transfer-domain,trade-domain,restore-domain}.ts` | 11 factories. |
| `src/mcp/tool-catalog.ts` | 11 catalog entries. |
| `src/server.ts` | import + register the 11 in `dispatchFactory`'s tools array. |
| tests | engine unit, schema unit, client Nock unit, DEFAULT_POLICY migration, dispatch integration. |

**Commands:** unit `npx vitest run <path>`; integration `npx vitest run --config vitest.integration.config.ts <path>`; typecheck `npm run typecheck`; lint `npm run lint`. Container boot ~50-70s — be patient.

---

## Task 1: `isReadTool` → prefix-based

**Files:** Modify `src/policies/engine.ts`; Test `src/policies/engine.test.ts`.

- [ ] **Step 1: Add failing tests** to `src/policies/engine.test.ts` (it already has a `describe('resolveToolMode')`/`isReadTool` block — add cases):
```ts
import { isReadTool } from './engine.js';
it('isReadTool matches read prefixes', () => {
  expect(isReadTool('suggest_domain')).toBe(true);
  expect(isReadTool('get_domain_authcode')).toBe(true);
  expect(isReadTool('list_dns_zones')).toBe(true);
  expect(isReadTool('check_domain')).toBe(true);
  expect(isReadTool('renew_domain')).toBe(false);
  expect(isReadTool('delete_domain')).toBe(false);
});
```

- [ ] **Step 2: Run → fail** `npx vitest run src/policies/engine.test.ts` (suggest_domain not in the READ_TOOLS set).

- [ ] **Step 3: Implement** — in `src/policies/engine.ts` replace `isReadTool` and make `evaluate` use it. Keep `READ_TOOLS` for the explicit oddballs:
```ts
const READ_TOOLS = new Set(['list_pending_confirmations']);
const READ_PREFIXES = ['list_', 'get_', 'check_', 'suggest_'];

export function isReadTool(toolName: string): boolean {
  if (READ_TOOLS.has(toolName)) return true;
  return READ_PREFIXES.some((p) => toolName.startsWith(p));
}
```
Then in `evaluate`, replace the line `const isRead = READ_TOOLS.has(input.toolName);` with `const isRead = isReadTool(input.toolName);` (DRY — both gates now use the same classifier).

- [ ] **Step 4: Run → pass** `npx vitest run src/policies/engine.test.ts` (existing viewer-gate tests still pass: `check_domain` was already read; the prior explicit reads — list_domains/get_domain/list_contacts/get_contact — now match prefixes).

- [ ] **Step 5: typecheck + commit**
```bash
npm run typecheck
git add src/policies/engine.ts src/policies/engine.test.ts
git commit -m "feat(op-batch1): prefix-based isReadTool (list_/get_/check_/suggest_)"
```

---

## Task 2: DEFAULT_POLICY modes + migration 0014

**Files:** Modify `src/policies/schema.ts`; Create `migrations/0014_domain_lifecycle_policy.sql`; Modify `migrations/meta/_journal.json`; Test `tests/integration/db/domain-lifecycle-policy.test.ts`.

- [ ] **Step 1: Update `DEFAULT_POLICY.tools` in `src/policies/schema.ts`** — add the wildcards + the 9 explicit write modes (the two reads — `suggest_domain`, `get_domain_authcode` — are covered by the `suggest_*`/`get_*` wildcards):
```ts
  tools: {
    'list_*': 'allow',
    'get_*': 'allow',
    'check_*': 'allow',
    'suggest_*': 'allow',
    check_domain: 'allow',
    register_domain: 'confirm',
    update_domain: 'confirm',
    delete_contact: 'confirm',
    update_contact: 'confirm',
    create_contact: 'allow',
    // Batch 1 — domain lifecycle
    reset_domain_authcode: 'allow',
    approve_domain_transfer: 'allow',
    send_foa1_domain_transfer: 'allow',
    delete_domain: 'confirm',
    restart_domain_operation: 'confirm',
    renew_domain: 'confirm',
    transfer_domain: 'confirm',
    trade_domain: 'confirm',
    restore_domain: 'confirm',
  },
```

- [ ] **Step 2: Write failing migration test** `tests/integration/db/domain-lifecycle-policy.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner } from '../_helpers/db.js';

describe('migration 0014 domain-lifecycle default policy', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => { fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool; }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  it('a freshly provisioned tenant has the new tool modes', async () => {
    const s = await seedTenantOwner(pool, 'b1-policy@example.com');
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const r = await c.query<{ doc: { tools: Record<string, unknown> } }>(
        `SELECT doc FROM policies WHERE tenant_id=$1`, [s.tenant_id]);
      const tools = r.rows[0]!.doc.tools;
      expect(tools['renew_domain']).toBe('confirm');
      expect(tools['delete_domain']).toBe('confirm');
      expect(tools['reset_domain_authcode']).toBe('allow');
      expect(tools['suggest_*']).toBe('allow');
    } finally { c.release(); }
  });
});
```

- [ ] **Step 3: Run → fail** (the seeded policy doc lacks the new keys).

- [ ] **Step 4: Create `migrations/0014_domain_lifecycle_policy.sql`** — `CREATE OR REPLACE FUNCTION signup_tenant(...)` identical to migration 0013's version EXCEPT the policy `doc` JSON literal now includes the new tool modes + wildcards. **Read the current `signup_tenant` body from `migrations/0013_local_auth.sql` and copy it verbatim, changing ONLY the `tools` object inside the `doc` JSON** to:
```json
"tools":{"list_*":"allow","get_*":"allow","check_*":"allow","suggest_*":"allow","check_domain":"allow","register_domain":"confirm","update_domain":"confirm","delete_contact":"confirm","update_contact":"confirm","create_contact":"allow","reset_domain_authcode":"allow","approve_domain_transfer":"allow","send_foa1_domain_transfer":"allow","delete_domain":"confirm","restart_domain_operation":"confirm","renew_domain":"confirm","transfer_domain":"confirm","trade_domain":"confirm","restore_domain":"confirm"}
```
(Keep the rest of the doc — version/spend_caps/tld lists/ip_allowlist — and the function's email_taken check + savepoint LOOP — unchanged. End with `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO app_role;`.) Append journal entry `{ "idx": 13, "version": "5", "when": 1748900000000, "tag": "0014_domain_lifecycle_policy", "breakpoints": true }`.

- [ ] **Step 5: Run → pass** `npx vitest run --config vitest.integration.config.ts tests/integration/db/domain-lifecycle-policy.test.ts`. `npm run typecheck`.

- [ ] **Step 6: Commit**
```bash
git add src/policies/schema.ts migrations/0014_domain_lifecycle_policy.sql migrations/meta/_journal.json tests/integration/db/domain-lifecycle-policy.test.ts
git commit -m "feat(op-batch1): default-policy modes for domain-lifecycle tools (migration 0014)"
```

---

## Task 3: Schemas (`types.ts`) for the 11 tools

**Files:** Modify `src/openprovider/types.ts`; Test `src/openprovider/types.test.ts` (create if absent, else append).

The existing `types.ts` has `const DomainRef = z.object({ name, extension })`-style shapes (see `RegisterDomainArgs.domain`). Reuse a shared `DomainRef`.

- [ ] **Step 1: Write failing schema tests** `src/openprovider/types.test.ts` (append/create) — one assertion per schema's required fields, e.g.:
```ts
import { describe, expect, it } from 'vitest';
import { RenewDomainArgs, TransferDomainArgs, SuggestDomainArgs, DomainIdArg, ResetAuthcodeArgs } from './types.js';
describe('batch1 schemas', () => {
  it('RenewDomainArgs requires id + period', () => {
    expect(RenewDomainArgs.safeParse({ id: 1, period: 1 }).success).toBe(true);
    expect(RenewDomainArgs.safeParse({ id: 1 }).success).toBe(false);
  });
  it('TransferDomainArgs requires domain + auth_code + owner_handle', () => {
    expect(TransferDomainArgs.safeParse({ domain: { name: 'x', extension: 'com' }, auth_code: 'a', owner_handle: 'H' }).success).toBe(true);
    expect(TransferDomainArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(false);
  });
  it('SuggestDomainArgs requires name', () => {
    expect(SuggestDomainArgs.safeParse({ name: 'example' }).success).toBe(true);
    expect(SuggestDomainArgs.safeParse({}).success).toBe(false);
  });
  it('DomainIdArg requires positive int id', () => {
    expect(DomainIdArg.safeParse({ id: 5 }).success).toBe(true);
    expect(DomainIdArg.safeParse({ id: -1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail** `npx vitest run src/openprovider/types.test.ts`.

- [ ] **Step 3: Add the schemas to `src/openprovider/types.ts`** (derive fields from the Postman bodies; `DomainRef` = `{name, extension}` strings):
```ts
const DomainRef = z.object({ name: z.string().min(1), extension: z.string().min(1) });

// id-in-path only (delete, get/reset authcode, send-foa1)
export const DomainIdArg = z.object({ id: z.number().int().positive() });

export const SuggestDomainArgs = z.object({
  name: z.string().min(1),
  tlds: z.array(z.string()).optional(),
  language: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  provider: z.string().optional(),
  sensitive: z.boolean().optional(),
}).passthrough();

export const ResetAuthcodeArgs = z.object({
  id: z.number().int().positive(),
  domain: DomainRef.optional(),
  auth_code_type: z.enum(['internal', 'registry']).optional(),
  sending_type: z.string().optional(),
}).passthrough();

export const ApproveTransferArgs = z.object({
  id: z.number().int().positive(),
  approve: z.union([z.literal(0), z.literal(1)]).optional(),
  auth_code: z.string().optional(),
  domain: DomainRef.optional(),
  registrar_tag: z.string().optional(),
}).passthrough();

export const RenewDomainArgs = z.object({
  id: z.number().int().positive(),
  period: z.number().int().positive(),
  domain: DomainRef.optional(),
}).passthrough();

export const TransferDomainArgs = z.object({
  domain: DomainRef,
  auth_code: z.string().min(1),
  owner_handle: z.string().min(1),
  admin_handle: z.string().optional(),
  tech_handle: z.string().optional(),
  billing_handle: z.string().optional(),
  ns_group: z.string().optional(),
}).passthrough();

export const TradeDomainArgs = z.object({
  domain: DomainRef,
  auth_code: z.string().min(1),
  owner_handle: z.string().min(1),
  admin_handle: z.string().optional(),
  tech_handle: z.string().optional(),
  billing_handle: z.string().optional(),
  ns_group: z.string().optional(),
}).passthrough();

export const RestoreDomainArgs = z.object({
  id: z.number().int().positive(),
  domain: DomainRef.optional(),
}).passthrough();

export const RestartDomainOperationArgs = z.object({
  id: z.number().int().positive(),
  auth_code: z.string().optional(),
  domain: DomainRef.optional(),
}).passthrough();
```
(`get_domain_authcode` and `delete_domain` and `send_foa1` all reuse `DomainIdArg`.)

- [ ] **Step 4: Run → pass.** `npm run typecheck`.
- [ ] **Step 5: Commit** `git add src/openprovider/types.ts src/openprovider/types.test.ts && git commit -m "feat(op-batch1): zod schemas for domain-lifecycle tools"`.

---

## Task 4: `OpenproviderClient` methods + Nock unit tests

**Files:** Modify `src/openprovider/client.ts` (+ its `OpenproviderClient` interface); Test `src/openprovider/client.test.ts` (append).

The client uses `request(method, path, token, body?)` and methods unwrap `(body as {data?}).data ?? body`. Add to the returned object + the interface.

- [ ] **Step 1: Add failing Nock tests** to `src/openprovider/client.test.ts` (mirror the existing `registerDomain`/`getDomain` Nock tests). One per method, e.g.:
```ts
it('renewDomain POSTs /domains/:id/renew', async () => {
  nock('https://api.openprovider.eu').post('/v1beta/domains/42/renew').reply(200, { data: { id: 42 } });
  const c = createOpenproviderClient();
  expect(await c.renewDomain('tok', 42, { id: 42, period: 1 })).toEqual({ id: 42 });
});
it('deleteDomain DELETEs /domains/:id', async () => {
  nock('https://api.openprovider.eu').delete('/v1beta/domains/42').reply(200, { data: { success: true } });
  expect(await createOpenproviderClient().deleteDomain('tok', 42)).toEqual({ success: true });
});
it('suggestDomain POSTs /domains/suggest-name', async () => {
  nock('https://api.openprovider.eu').post('/v1beta/domains/suggest-name').reply(200, { data: { results: [] } });
  expect(await createOpenproviderClient().suggestDomain('tok', { name: 'x' })).toEqual({ results: [] });
});
it('getDomainAuthcode GETs /domains/:id/authcode', async () => {
  nock('https://api.openprovider.eu').get('/v1beta/domains/42/authcode').reply(200, { data: { auth_code: 'ZZ' } });
  expect(await createOpenproviderClient().getDomainAuthcode('tok', 42)).toEqual({ auth_code: 'ZZ' });
});
```
(Add equivalent for transfer/trade/restore/restart/approveTransfer/sendFoa1/resetAuthcode — each asserting the right method+path+unwrapped data.)

- [ ] **Step 2: Run → fail** `npx vitest run src/openprovider/client.test.ts`.

- [ ] **Step 3: Add methods** to the object returned by `createOpenproviderClient` (and their signatures to the `OpenproviderClient` interface near the top of the file). Pattern (unwrap `.data`):
```ts
    async suggestDomain(token, args) {
      const b = await request('POST', '/domains/suggest-name', token, args);
      return (b as { data?: unknown }).data ?? b;
    },
    async getDomainAuthcode(token, id) {
      const b = await request('GET', `/domains/${id}/authcode`, token);
      return (b as { data?: unknown }).data ?? b;
    },
    async resetDomainAuthcode(token, id, args) {
      const b = await request('POST', `/domains/${id}/authcode/reset`, token, { ...args, id });
      return (b as { data?: unknown }).data ?? b;
    },
    async approveDomainTransfer(token, id, args) {
      const b = await request('POST', `/domains/${id}/transfer/approve`, token, { ...args, id });
      return (b as { data?: unknown }).data ?? b;
    },
    async sendFoa1DomainTransfer(token, id) {
      const b = await request('POST', `/domains/${id}/transfer/send-foa1`, token, { id });
      return (b as { data?: unknown }).data ?? b;
    },
    async deleteDomain(token, id) {
      const b = await request('DELETE', `/domains/${id}`, token);
      return (b as { data?: unknown }).data ?? b;
    },
    async restartDomainOperation(token, id, args) {
      const b = await request('POST', `/domains/${id}/last-operation/restart`, token, { ...args, id });
      return (b as { data?: unknown }).data ?? b;
    },
    async renewDomain(token, id, args) {
      const b = await request('POST', `/domains/${id}/renew`, token, { ...args, id });
      return (b as { data?: unknown }).data ?? b;
    },
    async transferDomain(token, args) {
      const b = await request('POST', '/domains/transfer', token, args);
      return (b as { data?: unknown }).data ?? b;
    },
    async tradeDomain(token, args) {
      const b = await request('POST', '/domains/trade', token, args);
      return (b as { data?: unknown }).data ?? b;
    },
    async restoreDomain(token, id, args) {
      const b = await request('POST', `/domains/${id}/restore`, token, { ...args, id });
      return (b as { data?: unknown }).data ?? b;
    },
```
Add matching signatures to the `OpenproviderClient` interface (use the new arg types: `RenewDomainArgs`, etc., imported in client.ts; `token: string`, `id: number`, returns `Promise<unknown>`).

- [ ] **Step 4: Run → pass** `npx vitest run src/openprovider/client.test.ts`. `npm run typecheck`.
- [ ] **Step 5: Commit** `git add src/openprovider/client.ts src/openprovider/client.test.ts && git commit -m "feat(op-batch1): OpenproviderClient domain-lifecycle methods"`.

---

## Task 5: Read tool factories (suggest_domain, get_domain_authcode)

**Files:** Create `src/tools/suggest-domain.ts`, `src/tools/get-domain-authcode.ts`; Modify `src/mcp/tool-catalog.ts`, `src/server.ts`.

- [ ] **Step 1: Create the factories** (mirror `get-domain.ts`):
```ts
// src/tools/suggest-domain.ts
import { SuggestDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';
export function createSuggestDomainTool(deps: { client: OpenproviderClient; tokenManager: OpenproviderTokenManager }) {
  return {
    name: 'suggest_domain',
    description: 'Suggest available domain names for a base name across TLDs.',
    inputSchema: SuggestDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = SuggestDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.suggestDomain(token, parsed);
    },
  };
}
```
```ts
// src/tools/get-domain-authcode.ts — uses DomainIdArg; calls client.getDomainAuthcode(token, parsed.id)
import { DomainIdArg } from '../openprovider/types.js';
// ...same shape... name: 'get_domain_authcode',
// description: 'Get the EPP auth/transfer code for a domain.',
// handler → deps.client.getDomainAuthcode(token, DomainIdArg.parse(args).id)
```

- [ ] **Step 2: Register in `buildToolCatalog`** (`src/mcp/tool-catalog.ts`) — import the two factories, instantiate with the existing stub deps (the file already uses `undefined as unknown as <Dep>` stubs), add to the `tools` array.

- [ ] **Step 3: Register in `dispatchFactory`** (`src/server.ts`) — import the two factories and add `createSuggestDomainTool({ client: openproviderClient, tokenManager })`, `createGetDomainAuthcodeTool({ client: openproviderClient, tokenManager })` to the `tools` array (alongside `createCheckDomainTool` etc.).

- [ ] **Step 4: Verify** `npm run typecheck` green; `npx vitest run src/mcp/tool-catalog.test.ts` — UPDATE the catalog test's expected name list to include `suggest_domain`, `get_domain_authcode` (and it'll grow per task; update as you add).
- [ ] **Step 5: Commit** `git add src/tools/suggest-domain.ts src/tools/get-domain-authcode.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch1): suggest_domain + get_domain_authcode (read tools)"`.

---

## Task 6: Allow-write tool factories (reset_domain_authcode, approve_domain_transfer, send_foa1_domain_transfer)

**Files:** Create `src/tools/{reset-domain-authcode,approve-domain-transfer,send-foa1-domain-transfer}.ts`; Modify `tool-catalog.ts`, `server.ts`.

- [ ] **Step 1: Create the 3 factories** (pattern: parse args, get token, call the client method). Names/schemas/methods:
  - `reset_domain_authcode` → `ResetAuthcodeArgs` → `client.resetDomainAuthcode(token, parsed.id, parsed)`. Desc: "Reset/regenerate a domain's EPP auth code."
  - `approve_domain_transfer` → `ApproveTransferArgs` → `client.approveDomainTransfer(token, parsed.id, parsed)`. Desc: "Approve an inbound/outbound domain transfer."
  - `send_foa1_domain_transfer` → `DomainIdArg` → `client.sendFoa1DomainTransfer(token, parsed.id)`. Desc: "Send the FOA1 transfer-confirmation email for a domain."
- [ ] **Step 2: Register** all 3 in `buildToolCatalog` + `dispatchFactory` (same as Task 5).
- [ ] **Step 3: Verify** typecheck green; update `tool-catalog.test.ts` expected names (+3); run it.
- [ ] **Step 4: Commit** `git add src/tools/reset-domain-authcode.ts src/tools/approve-domain-transfer.ts src/tools/send-foa1-domain-transfer.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch1): authcode-reset + transfer approve/foa1 (allow-mode tools)"`.

---

## Task 7: Confirm tool factories (delete, restart, renew, transfer, trade, restore)

**Files:** Create `src/tools/{delete-domain,restart-domain-operation,renew-domain,transfer-domain,trade-domain,restore-domain}.ts`; Modify `tool-catalog.ts`, `server.ts`.

These are dispatched through the existing confirm flow (DEFAULT_POLICY mode `confirm` from Task 2 → the dispatcher routes to propose/confirm_pending automatically; the tool handler runs only on owner/admin approval). The factory is the SAME shape — the confirm gating is policy-driven, not in the factory.

- [ ] **Step 1: Create the 6 factories.** Names/schemas/methods:
  - `delete_domain` → `DomainIdArg` → `client.deleteDomain(token, parsed.id)`. Desc: "Delete a domain (destructive; requires approval)."
  - `restart_domain_operation` → `RestartDomainOperationArgs` → `client.restartDomainOperation(token, parsed.id, parsed)`. Desc: "Restart the last domain operation (may re-bill; requires approval)."
  - `renew_domain` → `RenewDomainArgs` → `client.renewDomain(token, parsed.id, parsed)`. Desc: "Renew a domain for N years (billable; requires approval)."
  - `transfer_domain` → `TransferDomainArgs` → `client.transferDomain(token, parsed)`. Desc: "Transfer a domain in (billable; requires approval)."
  - `trade_domain` → `TradeDomainArgs` → `client.tradeDomain(token, parsed)`. Desc: "Trade (change owner of) a domain (billable; requires approval)."
  - `restore_domain` → `RestoreDomainArgs` → `client.restoreDomain(token, parsed.id, parsed)`. Desc: "Restore a domain from redemption (billable; requires approval)."
- [ ] **Step 2: Register** all 6 in `buildToolCatalog` + `dispatchFactory`.
- [ ] **Step 3: Verify** typecheck green; update `tool-catalog.test.ts` expected names (+6, total catalog now 12 existing + 11 = 23); run it.
- [ ] **Step 4: Commit** `git add src/tools/delete-domain.ts src/tools/restart-domain-operation.ts src/tools/renew-domain.ts src/tools/transfer-domain.ts src/tools/trade-domain.ts src/tools/restore-domain.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch1): delete/restart/renew/transfer/trade/restore (confirm-mode tools)"`.

---

## Task 8: Integration test + full suite + commit

**Files:** Create `tests/integration/mcp/domain-lifecycle-e2e.test.ts`.

- [ ] **Step 1: Write the integration test.** Model the dispatch wiring on `tests/integration/mcp/e2e.test.ts` (Phase-5 dispatchFactory with the tools array + confirm path). Seed a tenant via `seedTenantOwner`; build a dispatcher whose tools include the batch-1 tools + a real `resolveMode = resolveToolMode(policy, name, role)`; with NO Openprovider account connected, assert:
  - `tools/list` (or `buildToolCatalog()`) includes the 11 new names.
  - An **allow read** tool (`suggest_domain`) for an operator → reaches the handler → returns `openprovider_not_connected` (proves it dispatches + is allowed, no confirm).
  - A **confirm** tool (`renew_domain`) for an operator → returns `confirmation_required` (a confirmation id), NOT executed.
  - A **viewer** calling `delete_domain` → `policy_denied` (viewer can't run a non-read tool); a viewer calling `suggest_domain` → reaches handler (read, allowed).
  Keep assertions to the dispatch/policy behavior (no real OP calls needed — `openprovider_not_connected` is the expected terminal for allow tools without creds).

- [ ] **Step 2: Run → pass** `npx vitest run --config vitest.integration.config.ts tests/integration/mcp/domain-lifecycle-e2e.test.ts` (be patient with boot).

- [ ] **Step 3: Full gate** — `npm run typecheck` (0), `npm run lint` (0), `npx vitest run` (unit green), `npx vitest run --config vitest.integration.config.ts` (all green; 3 live skipped). Fix any regression (e.g. the `tool-catalog.test.ts` name list must equal all 23).

- [ ] **Step 4: Commit + STOP** (do NOT push — report for review/push approval):
```bash
git add tests/integration/mcp/domain-lifecycle-e2e.test.ts
git commit -m "test(op-batch1): domain-lifecycle dispatch + policy integration"
```

---

## Self-Review

**1. Spec coverage:** All 11 Batch-1 tools (suggest/get-authcode reads; reset-authcode/approve-transfer/foa1 allow; delete/restart/renew/transfer/trade/restore confirm) → Tasks 5/6/7; `isReadTool` prefix change → Task 1; DEFAULT_POLICY modes + migration → Task 2; schemas → Task 3; client methods → Task 4; integration → Task 8. ✅ Deviation from spec noted: billable ops are confirm-WITHOUT-spend here (spec's documented fallback) since operation-specific pricing needs Batch 3's Domain Price Service — flagged in the plan header + Task 7.

**2. Placeholder scan:** No TBD/TODO. The repetitive factories (Tasks 6/7) give the full pattern (Task 5 shows two complete factories) + each tool's exact name/schema/method/description — an engineer can produce each verbatim; not a placeholder.

**3. Type consistency:** Schema names (`RenewDomainArgs`, `TransferDomainArgs`, `TradeDomainArgs`, `RestoreDomainArgs`, `RestartDomainOperationArgs`, `ResetAuthcodeArgs`, `ApproveTransferArgs`, `SuggestDomainArgs`, `DomainIdArg`) match across Tasks 3→4→5/6/7. Client method names (`renewDomain`, `transferDomain`, `tradeDomain`, `restoreDomain`, `restartDomainOperation`, `deleteDomain`, `resetDomainAuthcode`, `approveDomainTransfer`, `sendFoa1DomainTransfer`, `suggestDomain`, `getDomainAuthcode`) match Task 4→factories. Tool names match the DEFAULT_POLICY keys (Task 2) and `isReadTool` prefixes (Task 1). The catalog test's expected count grows to 23 (12 existing + 11). ✅

*End of plan.*

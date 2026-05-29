# OP Coverage Batch 3 — Catalog + Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the 6 catalog + tag Openprovider tools (`list_tlds`, `get_tld`, `get_domain_price`, `list_tags`, `create_tag`, `delete_tag`) to the MCP, following the Batch-1/2 tool pattern.

**Architecture:** Same per-tool pattern as prior batches: zod schema (`src/openprovider/types.ts`) + `OpenproviderClient` method (`src/openprovider/client.ts`) + factory (`src/tools/*.ts`) + `buildToolCatalog` entry (`src/mcp/tool-catalog.ts`) + `dispatchFactory` registration (`src/server.ts`) + `DEFAULT_POLICY` mode (`src/policies/schema.ts` + a `signup_tenant` migration). 4 reads (covered by existing `list_*`/`get_*` wildcards), 1 allow-write (`create_tag`), 1 confirm (`delete_tag`).

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, fetch-based client, Postgres (policy seeded in `signup_tenant`), Vitest + Nock + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-28-openprovider-full-api-coverage-design.md` (§3 Batch 3). **Branch:** `feat/enterprise-phase-1`.

---

## Corrections to the spec (from re-reading the Postman collection)
The spec's mode table was approximate; the actual collection differs in two places:
1. **`create_tag` body is `{ key, value }`** (both required strings) — NOT `{ name, color, description }`. OP tags are key/value pairs (e.g. tag a customer with `key=customer, value=Tech`).
2. **`delete_tag` is `DELETE /tags?key=...&value=...`** — there is NO `/tags/:id` path variant in the collection; deletion is by key+value query params. So the tool accepts `{ key, value }`, not an id.
3. **`get_domain_price` is `GET /domains/prices`** with dot-notation QUERY params: `domain.name`, `domain.extension`, `operation` (enum `create|transfer|restore|renew`), and optional `additional_data.idn_script`. No path param, no body.

Modes remain unchanged from the spec: `list_tlds`/`get_tld`/`get_domain_price`/`list_tags` = R (allow via wildcards); `create_tag` = A (explicit allow); `delete_tag` = C (explicit confirm — the destructive op classification holds even though it's not a path-id delete).

## Endpoint reference (exact, from Postman collection)
| tool | method | path / query | body | mode |
|---|---|---|---|---|
| `list_tlds` | GET | `/tlds` | — | R |
| `get_tld` | GET | `/tlds/:name` (TLD string, e.g. `"com"`) | — | R |
| `get_domain_price` | GET | `/domains/prices?domain.name=...&domain.extension=...&operation=...[&additional_data.idn_script=...]` | — | R |
| `list_tags` | GET | `/tags` | — | R |
| `create_tag` | POST | `/tags` | `{ key, value }` | A |
| `delete_tag` | DELETE | `/tags?key=...&value=...` | — | C |

**Catalog count:** 44 (after Batch 2) → **50**.

**Client contract (established in Batch 1/2 — follow exactly):**
- Arg-typed methods take `(token, args)` and `XxxArgs.parse(args)` inside.
- Path-only methods take `(token, identifier)` where identifier is a `number` or `string`; string path params `encodeURIComponent`-encoded.
- List methods take `(token)`.
- All unwrap `(b as { data?: unknown }).data ?? b`.
- For query-string methods (`getDomainPrice`, `deleteTag`), build the query via `URLSearchParams` and append it to the path before calling `request(...)` (dot-notation keys are fine — `URLSearchParams.append('domain.name', 'x')` produces `domain.name=x` which OP accepts).

**Note on follow-up (NOT in this batch):** `get_domain_price` is the Domain Price Service that lets the policy engine upgrade Batch-1 billable tools (`renew_domain`/`transfer_domain`/`trade_domain`/`restore_domain`) from confirm-without-spend to true confirm+spend-cap. That integration into `src/policies/pricing.ts` is a follow-up task after this batch lands — it requires response-shape exploration via the live API and changes to `BILLABLE`/`price()`. Out of scope here; this batch only exposes the tool.

**Commands:** unit `npx vitest run <path>`; integration `npx vitest run --config vitest.integration.config.ts <path>`; `npm run typecheck`; `npm run lint`. Container boot ~50-70s.

---

## Task 1: DEFAULT_POLICY modes + migration 0016

**Files:** Modify `src/policies/schema.ts`; Create `migrations/0016_tags_policy.sql`; Modify `migrations/meta/_journal.json`; Test `tests/integration/db/tags-policy.test.ts`.

- [ ] **Step 1: Add 2 explicit modes to `DEFAULT_POLICY.tools` in `src/policies/schema.ts`** (after the Batch-2 entries; keep everything else):
```ts
    create_tag: 'allow',
    delete_tag: 'confirm',
```

- [ ] **Step 2: Write failing migration test** `tests/integration/db/tags-policy.test.ts` — model on `tests/integration/db/dns-policy.test.ts` (same helpers, 120_000 beforeAll, defensive afterAll, BEGIN/SET LOCAL ROLE app_role/set_config to read `policies` under RLS):
```ts
expect(tools['create_tag']).toBe('allow');
expect(tools['delete_tag']).toBe('confirm');
```
Use a distinct email like `b3-tags-policy@example.com`.

- [ ] **Step 3: Run → fail** `npx vitest run --config vitest.integration.config.ts tests/integration/db/tags-policy.test.ts`.

- [ ] **Step 4: Create `migrations/0016_tags_policy.sql`** — `CREATE OR REPLACE FUNCTION signup_tenant(...)` copied VERBATIM from `migrations/0015_dns_policy.sql` (the current latest). Change ONLY the `tools` object inside the inserted policy `doc` JSON to ALSO include the 2 new keys (append after the Batch-2 DNS keys, before the closing brace):
```json
,"create_tag":"allow","delete_tag":"confirm"
```
Keep every other part of the doc + function body byte-identical to 0015. End with the same `REVOKE ALL ... FROM PUBLIC;` + `GRANT EXECUTE ... TO app_role;`. Append a journal entry to `migrations/meta/_journal.json` (idx 15, tag `0016_tags_policy`, copying the field shape of the idx-14 `0015_dns_policy` entry).

- [ ] **Step 5: Run → pass.** `npm run typecheck`.

- [ ] **Step 6: Commit**
```bash
git add src/policies/schema.ts migrations/0016_tags_policy.sql migrations/meta/_journal.json tests/integration/db/tags-policy.test.ts
git commit -m "feat(op-batch3): default-policy modes for tags (migration 0016)"
```

---

## Task 2: Schemas (`types.ts`) for the 6 tools

**Files:** Modify `src/openprovider/types.ts`; Test `src/openprovider/types.test.ts` (append).

The existing `NoArgs` from Batch 2 is reused for `list_tlds` and `list_tags`. Add:

- [ ] **Step 1: Write failing schema tests** (append to `src/openprovider/types.test.ts`):
```ts
import { TldNameArg, GetDomainPriceArgs, CreateTagArgs, DeleteTagArgs } from './types.js';
describe('batch3 catalog+tags schemas', () => {
  it('TldNameArg requires name', () => {
    expect(TldNameArg.safeParse({ name: 'com' }).success).toBe(true);
    expect(TldNameArg.safeParse({}).success).toBe(false);
  });
  it('GetDomainPriceArgs requires domain+operation; idn_script optional', () => {
    expect(GetDomainPriceArgs.safeParse({ domain: { name: 'x', extension: 'com' }, operation: 'create' }).success).toBe(true);
    expect(GetDomainPriceArgs.safeParse({ domain: { name: 'x', extension: 'com' }, operation: 'create', additional_data: { idn_script: 'cyrl' } }).success).toBe(true);
    expect(GetDomainPriceArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(false);
    expect(GetDomainPriceArgs.safeParse({ domain: { name: 'x', extension: 'com' }, operation: 'bogus' }).success).toBe(false);
  });
  it('CreateTagArgs requires key+value', () => {
    expect(CreateTagArgs.safeParse({ key: 'customer', value: 'Tech' }).success).toBe(true);
    expect(CreateTagArgs.safeParse({ key: 'customer' }).success).toBe(false);
  });
  it('DeleteTagArgs requires key+value', () => {
    expect(DeleteTagArgs.safeParse({ key: 'customer', value: 'Tech' }).success).toBe(true);
    expect(DeleteTagArgs.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Add schemas to `src/openprovider/types.ts`** (reuse the existing `DomainRef` for the price tool's `domain` field):
```ts
export const TldNameArg = z.object({ name: z.string().min(1) });

const DomainPriceOperation = z.enum(['create', 'transfer', 'restore', 'renew']);
export const GetDomainPriceArgs = z.object({
  domain: DomainRef,
  operation: DomainPriceOperation,
  additional_data: z.object({
    idn_script: z.string().optional(),
  }).optional(),
});

export const CreateTagArgs = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});

export const DeleteTagArgs = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});
```
Add `export type Xxx = z.infer<typeof Xxx>` for each. Use the file's existing plain-`z.object` style (no `.strict()`/`.passthrough()`).

- [ ] **Step 4: Run → pass.** `npm run typecheck`.
- [ ] **Step 5: Commit** `git add src/openprovider/types.ts src/openprovider/types.test.ts && git commit -m "feat(op-batch3): zod schemas for catalog + tag tools"`.

---

## Task 3: `OpenproviderClient` methods + Nock unit tests

**Files:** Modify `src/openprovider/client.ts` (+ interface); Test `src/openprovider/client.test.ts` (append).

> **Mock cascade:** Batch 1 & 2 hit this — adding 6 methods to the `OpenproviderClient` interface breaks every mock-client object. After implementing, run `npm run typecheck` and add `vi.fn()` stubs for all 6 new methods to every failing mock (`src/policies/pricing.test.ts` `clientWith`, `src/tools/check-domain.test.ts`, `src/tools/read-tools.test.ts`, `src/tools/write-tools.test.ts`). Commit those mock fixes together with this task.

The 6 methods:
- `listTlds(token): Promise<unknown>` → GET `/tlds`
- `getTld(token, name: string)` → GET `/tlds/${encodeURIComponent(name)}`
- `getDomainPrice(token, args: GetDomainPriceArgs)` → GET `/domains/prices?<query>` — build query via `URLSearchParams` from parsed args (keys: `domain.name`, `domain.extension`, `operation`, and `additional_data.idn_script` if provided)
- `listTags(token)` → GET `/tags`
- `createTag(token, args: CreateTagArgs)` → POST `/tags`, body = parsed
- `deleteTag(token, args: DeleteTagArgs)` → DELETE `/tags?key=...&value=...` — build query via `URLSearchParams` from parsed args (keys: `key`, `value`)

Each unwraps `(b as { data?: unknown }).data ?? b`.

- [ ] **Step 1: Add failing Nock tests** (append to `src/openprovider/client.test.ts`; reuse the existing `BASE`/`PREFIX` consts). For query-string methods, use a Nock path matcher that includes the encoded query:
```ts
it('listTlds GETs /tlds', async () => {
  nock(BASE).get(`${PREFIX}/tlds`).reply(200, { data: [] });
  expect(await createOpenproviderClient().listTlds('tok')).toEqual([]);
});
it('getTld GETs /tlds/:name (encoded)', async () => {
  nock(BASE).get(`${PREFIX}/tlds/co.uk`).reply(200, { data: { name: 'co.uk' } });
  expect(await createOpenproviderClient().getTld('tok', 'co.uk')).toEqual({ name: 'co.uk' });
});
it('getDomainPrice GETs /domains/prices with dot-notation query params', async () => {
  nock(BASE).get(`${PREFIX}/domains/prices`).query({ 'domain.name': 'x', 'domain.extension': 'com', operation: 'create' }).reply(200, { data: { price: { product: { price: 9.99, currency: 'USD' } } } });
  expect(await createOpenproviderClient().getDomainPrice('tok', { domain: { name: 'x', extension: 'com' }, operation: 'create' })).toEqual({ price: { product: { price: 9.99, currency: 'USD' } } });
});
it('getDomainPrice includes idn_script when provided', async () => {
  nock(BASE).get(`${PREFIX}/domains/prices`).query({ 'domain.name': 'x', 'domain.extension': 'com', operation: 'create', 'additional_data.idn_script': 'cyrl' }).reply(200, { data: { ok: true } });
  expect(await createOpenproviderClient().getDomainPrice('tok', { domain: { name: 'x', extension: 'com' }, operation: 'create', additional_data: { idn_script: 'cyrl' } })).toEqual({ ok: true });
});
it('listTags GETs /tags', async () => {
  nock(BASE).get(`${PREFIX}/tags`).reply(200, { data: [] });
  expect(await createOpenproviderClient().listTags('tok')).toEqual([]);
});
it('createTag POSTs /tags with {key,value}', async () => {
  nock(BASE).post(`${PREFIX}/tags`, (b: Record<string, unknown>) => b['key'] === 'customer' && b['value'] === 'Tech').reply(200, { data: { ok: true } });
  expect(await createOpenproviderClient().createTag('tok', { key: 'customer', value: 'Tech' })).toEqual({ ok: true });
});
it('deleteTag DELETEs /tags?key=...&value=...', async () => {
  nock(BASE).delete(`${PREFIX}/tags`).query({ key: 'customer', value: 'Tech' }).reply(200, { data: { ok: true } });
  expect(await createOpenproviderClient().deleteTag('tok', { key: 'customer', value: 'Tech' })).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** the 6 methods + interface signatures. Read `src/openprovider/client.ts` first to confirm whether `request(method, path, token, body?)` accepts the path string with a `?query` suffix already appended (the existing pattern). For query-string methods, build the URL like this:
```ts
    async listTlds(token) {
      const b = await request('GET', '/tlds', token);
      return (b as { data?: unknown }).data ?? b;
    },
    async getTld(token, name) {
      const b = await request('GET', `/tlds/${encodeURIComponent(name)}`, token);
      return (b as { data?: unknown }).data ?? b;
    },
    async getDomainPrice(token, args) {
      const parsed = GetDomainPriceArgs.parse(args);
      const params = new URLSearchParams();
      params.append('domain.name', parsed.domain.name);
      params.append('domain.extension', parsed.domain.extension);
      params.append('operation', parsed.operation);
      if (parsed.additional_data?.idn_script) {
        params.append('additional_data.idn_script', parsed.additional_data.idn_script);
      }
      const b = await request('GET', `/domains/prices?${params.toString()}`, token);
      return (b as { data?: unknown }).data ?? b;
    },
    async listTags(token) {
      const b = await request('GET', '/tags', token);
      return (b as { data?: unknown }).data ?? b;
    },
    async createTag(token, args) {
      const parsed = CreateTagArgs.parse(args);
      const b = await request('POST', '/tags', token, parsed);
      return (b as { data?: unknown }).data ?? b;
    },
    async deleteTag(token, args) {
      const parsed = DeleteTagArgs.parse(args);
      const params = new URLSearchParams({ key: parsed.key, value: parsed.value });
      const b = await request('DELETE', `/tags?${params.toString()}`, token);
      return (b as { data?: unknown }).data ?? b;
    },
```
Interface signatures: `listTlds(token: string): Promise<unknown>`, `getTld(token: string, name: string): Promise<unknown>`, `getDomainPrice(token: string, args: GetDomainPriceArgs): Promise<unknown>`, `listTags(token: string): Promise<unknown>`, `createTag(token: string, args: CreateTagArgs): Promise<unknown>`, `deleteTag(token: string, args: DeleteTagArgs): Promise<unknown>`. Import the 3 new arg types from `./types.js`.

- [ ] **Step 4: Run + fix mock cascade.** Tests green; then `npm run typecheck` will fail in mock files — add `vi.fn()` stubs for all 6 new methods to each failing mock. Re-run typecheck (0) and `npx vitest run` (full unit suite green).

- [ ] **Step 5: Commit** (include the mock-fix files):
```bash
git add src/openprovider/client.ts src/openprovider/client.test.ts <every mock test file you fixed>
git commit -m "feat(op-batch3): OpenproviderClient catalog + tag methods"
```

---

## Task 4: Tool factories (6) + catalog + dispatch

**Files:** Create `src/tools/{list-tlds,get-tld,get-domain-price,list-tags,create-tag,delete-tag}.ts`; Modify `src/mcp/tool-catalog.ts`, `src/server.ts`, `src/mcp/tool-catalog.test.ts`.

All factories follow the established pattern: `(deps) => ({ name, description, inputSchema, handler })` where handler does `const parsed = <Schema>.parse(args); const token = await deps.tokenManager.getToken(principal.tenantId); return deps.client.<method>(...);`.

- [ ] **Step 1: Create the 6 factories.** name / factory / inputSchema / client call / description:
  - `list_tlds` / `createListTldsTool` / `NoArgs` / `client.listTlds(token)` / "List all TLDs."
  - `get_tld` / `createGetTldTool` / `TldNameArg` / `client.getTld(token, parsed.name)` / "Get TLD metadata by name."
  - `get_domain_price` / `createGetDomainPriceTool` / `GetDomainPriceArgs` / `client.getDomainPrice(token, parsed)` / "Get the registration/renew/transfer/restore price for a domain."
  - `list_tags` / `createListTagsTool` / `NoArgs` / `client.listTags(token)` / "List tags."
  - `create_tag` / `createCreateTagTool` / `CreateTagArgs` / `client.createTag(token, parsed)` / "Create a tag (key/value pair)."
  - `delete_tag` / `createDeleteTagTool` / `DeleteTagArgs` / `client.deleteTag(token, parsed)` / "Delete a tag by key/value (requires approval)."
  Mirror Batch-2's `src/tools/list-dns-zones.ts` (read), `src/tools/create-dns-zone.ts` (allow-write), and `src/tools/delete-dns-zone.ts` (confirm-delete).

- [ ] **Step 2: Register in catalog + dispatch.**
  - `src/mcp/tool-catalog.ts`: import all 6, instantiate with stub-deps, add to catalog.
  - `src/server.ts`: import all 6, add `create<Name>Tool({ client: openproviderClient, tokenManager })` for each to the dispatchFactory tools array.

- [ ] **Step 3: Update catalog test.** `src/mcp/tool-catalog.test.ts`: add 6 names; bump count 44 → 50.

- [ ] **Step 4: Verify** `npm run typecheck` (0); `npx vitest run src/mcp/tool-catalog.test.ts`; `npx vitest run` (full unit green).

- [ ] **Step 5: Commit** `git add src/tools/list-tlds.ts src/tools/get-tld.ts src/tools/get-domain-price.ts src/tools/list-tags.ts src/tools/create-tag.ts src/tools/delete-tag.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch3): catalog + tag tools (list/get tld, get price, list/create/delete tag)"`.

---

## Task 5: Integration test + full gate + commit

**Files:** Create `tests/integration/mcp/catalog-tags-e2e.test.ts`.

Model on `tests/integration/mcp/dns-e2e.test.ts` (the proven Batch-2 harness). Seed a tenant; no OP creds connected. Assert:

- [ ] **Step 1: Write the test.**
  1. `buildToolCatalog()` / `tools/list` includes all 6 new names.
  2. An **allow read** (`list_tlds`, `{}`) for an operator → reaches handler → `openprovider_not_connected` (the established discriminator: `body.error?.data?.code === 'openprovider_not_connected'`).
  3. An **allow read with body** (`get_domain_price`, valid args `{ domain: { name: 'x', extension: 'com' }, operation: 'create' }`) for an operator → reaches handler → `openprovider_not_connected`.
  4. An **allow write** (`create_tag`, `{ key: 'k', value: 'v' }`) for an operator → reaches handler → `openprovider_not_connected` (proves allow, no confirm).
  5. A **confirm** tool (`delete_tag`, `{ key: 'k', value: 'v' }`) for an operator → returns the confirmation-proposal shape (`{ confirmationId, confirmationToken, expiresAt, requiredApproverRoles }` parsed from `result.content[0].text`), NOT executed.
  6. **Viewer gate:** viewer calling `delete_tag` → `body.error?.data?.code === 'policy_denied'`; viewer calling `create_tag` → `policy_denied`; viewer calling `list_tlds` (read) → reaches handler (`openprovider_not_connected`).
  Use the exact harness wiring from `dns-e2e.test.ts`.

- [ ] **Step 2: Run → pass** `npx vitest run --config vitest.integration.config.ts tests/integration/mcp/catalog-tags-e2e.test.ts` (patient on boot).

- [ ] **Step 3: FULL gate** — `npm run typecheck` (0), `npm run lint` (0), `npx vitest run` (unit green), `npx vitest run --config vitest.integration.config.ts` (integration green; live skips OK). Catalog test count must equal 50.

- [ ] **Step 4: Commit + STOP** (do NOT push):
```bash
git add tests/integration/mcp/catalog-tags-e2e.test.ts
git commit -m "test(op-batch3): catalog + tag dispatch + policy integration"
```

---

## Self-Review

**1. Spec coverage:** All 6 Batch-3 tools (4 reads, 1 allow-write, 1 delete) → Task 4; DEFAULT_POLICY + migration → Task 1; schemas → Task 2; client methods → Task 3; integration → Task 5. The two spec deviations (tag body is `{key,value}`; delete_tag is by query params, not `:id`) are documented at the top and reflected in the schemas + client + tests. ✅

**2. Placeholder scan:** No TBD/TODO. The plan gives full code for each method/schema/factory; the per-factory table in Task 4 has each tool's exact name/schema/method/description.

**3. Type consistency:** Schema names (`TldNameArg`, `GetDomainPriceArgs`, `CreateTagArgs`, `DeleteTagArgs`) match across Tasks 2→3→4. Client method names (`listTlds`, `getTld`, `getDomainPrice`, `listTags`, `createTag`, `deleteTag`) match Task 3 → factories. Tool names match DEFAULT_POLICY keys (`create_tag`, `delete_tag`). Catalog grows 44 → 50. ✅

**Deferred follow-up (NOT in this batch):** Integrate `get_domain_price` into `src/policies/pricing.ts` to enable true confirm+spend-cap for the Batch-1 billable tools (`renew_domain`/`transfer_domain`/`trade_domain`/`restore_domain`). Needs response-shape exploration (the Postman collection has no saved response example) + changes to `BILLABLE`/`price()`/`tldsOf` for those four ops. Defer to a separate task after Batch 3 ships.

*End of plan.*

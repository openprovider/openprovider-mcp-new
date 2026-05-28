# OP Coverage Batch 2 — DNS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the 21 DNS Openprovider tools (zones, zone-records list, nameservers, ns-groups, DNS templates, domain-token) to the MCP, following the Batch-1 tool pattern, and fix `ruleFor` to do true longest-prefix wildcard matching first.

**Architecture:** Same per-tool pattern as Batch 1: zod schema (`src/openprovider/types.ts`) + `OpenproviderClient` method (`src/openprovider/client.ts`) + factory (`src/tools/*.ts`) + `buildToolCatalog` entry (`src/mcp/tool-catalog.ts`) + `dispatchFactory` registration (`src/server.ts`) + `DEFAULT_POLICY` mode (`src/policies/schema.ts` + a `signup_tenant` migration). Reads (`list_*`/`get_*`) are viewer-accessible via existing wildcards; the 8 low-risk writes (create/update zone/nameserver/ns-group, create template, create domain-token) are `allow`; the 4 deletes are `confirm`. DNS record mutation happens through `update_dns_zone` (records `{add,remove}` payload) — no separate record-CRUD tools.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, fetch-based `OpenproviderClient`, Postgres (policy seeded in `signup_tenant`), Vitest + Nock + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-28-openprovider-full-api-coverage-design.md` (§3 Batch 2). **Branch:** `feat/enterprise-phase-1`.

---

## Client contract (established in Batch 1 — follow exactly)
- Arg-typed methods take `(token, args)` and `XxxArgs.parse(args)` inside; path params for write endpoints are derived from a parsed field (NOT a separate id param).
- Path-only methods take `(token, identifier)` where identifier is a `number` (template id) or `string` (zone/nameserver/ns-group name). **`encodeURIComponent(...)` all string path params.**
- List methods take `(token)`.
- All unwrap `(body as { data?: unknown }).data ?? body`.

## DNS endpoint reference (exact, from the Postman collection)
| tool | method | path | identifier | mode |
|---|---|---|---|---|
| `list_dns_zones` | GET | `/dns/zones` | — | R |
| `get_dns_zone` | GET | `/dns/zones/:name` | zone FQDN string | R |
| `create_dns_zone` | POST | `/dns/zones` | — | A |
| `update_dns_zone` | PUT | `/dns/zones/:name` | derive `:name` = `${domain.name}.${domain.extension}` | A |
| `delete_dns_zone` | DELETE | `/dns/zones/:name` | zone FQDN string | C |
| `list_dns_zone_records` | GET | `/dns/zones/:name/records` | zone FQDN string | R |
| `list_nameservers` | GET | `/dns/nameservers` | — | R |
| `get_nameserver` | GET | `/dns/nameservers/:name` | nameserver FQDN string | R |
| `create_nameserver` | POST | `/dns/nameservers` | — | A |
| `update_nameserver` | PUT | `/dns/nameservers/:name` | derive `:name` = `args.name` | A |
| `delete_nameserver` | DELETE | `/dns/nameservers/:name` | nameserver FQDN string | C |
| `list_ns_groups` | GET | `/dns/nameservers/groups` | — | R |
| `get_ns_group` | GET | `/dns/nameservers/groups/:ns_group` | group name string | R |
| `create_ns_group` | POST | `/dns/nameservers/groups` | — | A |
| `update_ns_group` | PUT | `/dns/nameservers/groups/:ns_group` | derive `:ns_group` = `args.ns_group` | A |
| `delete_ns_group` | DELETE | `/dns/nameservers/groups/:ns_group` | group name string | C |
| `list_dns_templates` | GET | `/dns/templates` | — | R |
| `get_dns_template` | GET | `/dns/templates/:id` | numeric id | R |
| `create_dns_template` | POST | `/dns/templates` | — | A |
| `delete_dns_template` | DELETE | `/dns/templates/:id` | numeric id | C |
| `create_domain_token` | POST | `/dns/domain-token` | — | A |

Reads (9): `list_dns_zones, get_dns_zone, list_dns_zone_records, list_nameservers, get_nameserver, list_ns_groups, get_ns_group, list_dns_templates, get_dns_template` — covered by `list_*`/`get_*` allow wildcards (no explicit policy entry needed).
Explicit modes to add (12): 8 allow + 4 confirm (deletes).

**Catalog count:** 23 (after Batch 1) → **44**.

**Commands:** unit `npx vitest run <path>`; integration `npx vitest run --config vitest.integration.config.ts <path>`; `npm run typecheck`; `npm run lint`. Container boot ~50-70s.

---

## Task 1: `ruleFor` true longest-prefix match

**Files:** Modify `src/policies/schema.ts`; Test `src/policies/schema.test.ts` (append; create if absent).

**Why:** A final reviewer flagged that `ruleFor` returns the FIRST matching wildcard in `Object.entries` order, but its comment claims "longest matching prefix." Harmless today (read wildcards don't overlap), but it will bite when overlapping wildcards appear. Fix it now before more tools land.

- [ ] **Step 1: Read `src/policies/schema.ts`** — find `ruleFor` (around lines 55-66). Note its exact current shape: it returns `policy.tools[exactName]` if present, else loops wildcard keys and returns the first whose prefix matches.

- [ ] **Step 2: Add failing test** to `src/policies/schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ruleFor, type Policy } from './schema.js';
// If ruleFor is not exported, export it (add `export`).
describe('ruleFor longest-prefix wildcard matching', () => {
  const policy = { tools: { 'get_*': 'allow', 'get_secret_*': 'confirm', delete_domain: 'confirm' } } as unknown as Policy;
  it('exact match wins over any wildcard', () => {
    expect(ruleFor(policy, 'delete_domain')).toBe('confirm');
  });
  it('longest matching wildcard wins (get_secret_* over get_*)', () => {
    expect(ruleFor(policy, 'get_secret_value')).toBe('confirm');
  });
  it('falls back to the broad wildcard when no longer prefix matches', () => {
    expect(ruleFor(policy, 'get_domain')).toBe('allow');
  });
});
```
(Match the actual `ruleFor` return shape — it may return a mode string or a rule object; adapt the assertions to whatever the real signature returns, e.g. `.mode`. Read the function first and shape the test to its real contract. The CORE assertion is: `get_secret_value` resolves to the `get_secret_*` rule, not `get_*`.)

- [ ] **Step 3: Run → fail** `npx vitest run src/policies/schema.test.ts` (first-match returns `get_*`).

- [ ] **Step 4: Implement longest-prefix.** In `ruleFor`, keep the exact-match short-circuit, then among wildcard keys (those ending in `*`) collect every key whose prefix (key minus `*`) is a prefix of the tool name, and return the rule for the one with the LONGEST prefix:
```ts
  // exact match first (unchanged)
  if (policy.tools[toolName]) return policy.tools[toolName];
  let best: string | undefined;
  let bestLen = -1;
  for (const key of Object.keys(policy.tools)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (toolName.startsWith(prefix) && prefix.length > bestLen) {
      best = key;
      bestLen = prefix.length;
    }
  }
  return best ? policy.tools[best] : <existing default/undefined>;
```
Preserve the function's existing return type and its default-when-no-match behavior (unmapped → the engine treats it as deny; do not change that). Fix the misleading comment to describe longest-prefix.

- [ ] **Step 5: Run → pass** `npx vitest run src/policies/schema.test.ts`. Then `npx vitest run src/policies/engine.test.ts` (the engine uses ruleFor — must still be green). `npm run typecheck`.

- [ ] **Step 6: Commit**
```bash
git add src/policies/schema.ts src/policies/schema.test.ts
git commit -m "fix(op-batch2): ruleFor longest-prefix wildcard match"
```

---

## Task 2: DEFAULT_POLICY modes + migration 0015

**Files:** Modify `src/policies/schema.ts`; Create `migrations/0015_dns_policy.sql`; Modify `migrations/meta/_journal.json`; Test `tests/integration/db/dns-policy.test.ts`.

- [ ] **Step 1: Add the 12 explicit modes to `DEFAULT_POLICY.tools` in `src/policies/schema.ts`** (after the Batch-1 entries; keep everything already there):
```ts
    create_dns_zone: 'allow',
    update_dns_zone: 'allow',
    delete_dns_zone: 'confirm',
    create_nameserver: 'allow',
    update_nameserver: 'allow',
    delete_nameserver: 'confirm',
    create_ns_group: 'allow',
    update_ns_group: 'allow',
    delete_ns_group: 'confirm',
    create_dns_template: 'allow',
    delete_dns_template: 'confirm',
    create_domain_token: 'allow',
```

- [ ] **Step 2: Write failing migration test** `tests/integration/db/dns-policy.test.ts` — model on `tests/integration/db/domain-lifecycle-policy.test.ts` (same helpers, 120_000 beforeAll, defensive afterAll, BEGIN/SET LOCAL ROLE app_role/set_config to read `policies` under RLS). Assert a freshly provisioned tenant carries the new modes:
```ts
expect(tools['create_dns_zone']).toBe('allow');
expect(tools['update_dns_zone']).toBe('allow');
expect(tools['delete_dns_zone']).toBe('confirm');
expect(tools['delete_ns_group']).toBe('confirm');
expect(tools['create_domain_token']).toBe('allow');
```
Read `tests/integration/db/domain-lifecycle-policy.test.ts` and copy its structure exactly (it's the proven Batch-1 version).

- [ ] **Step 3: Run → fail** `npx vitest run --config vitest.integration.config.ts tests/integration/db/dns-policy.test.ts`.

- [ ] **Step 4: Create `migrations/0015_dns_policy.sql`** — `CREATE OR REPLACE FUNCTION signup_tenant(...)` copied VERBATIM from `migrations/0014_domain_lifecycle_policy.sql` (the current latest), changing ONLY the `tools` object in the inserted policy `doc` JSON to ALSO include the 12 new DNS keys (append to the Batch-1 `tools` set):
```json
,"create_dns_zone":"allow","update_dns_zone":"allow","delete_dns_zone":"confirm","create_nameserver":"allow","update_nameserver":"allow","delete_nameserver":"confirm","create_ns_group":"allow","update_ns_group":"allow","delete_ns_group":"confirm","create_dns_template":"allow","delete_dns_template":"confirm","create_domain_token":"allow"
```
Keep every other part of the doc + the function body byte-identical to 0014. End with the same `REVOKE ALL ... FROM PUBLIC;` + `GRANT EXECUTE ... TO app_role;`. Append a journal entry to `migrations/meta/_journal.json` (idx 14, tag `0015_dns_policy`, copying the field shape of the idx-13 `0014_domain_lifecycle_policy` entry — drizzle migrator reads the journal).

- [ ] **Step 5: Run → pass** `npx vitest run --config vitest.integration.config.ts tests/integration/db/dns-policy.test.ts`. `npm run typecheck`.

- [ ] **Step 6: Commit**
```bash
git add src/policies/schema.ts migrations/0015_dns_policy.sql migrations/meta/_journal.json tests/integration/db/dns-policy.test.ts
git commit -m "feat(op-batch2): default-policy modes for DNS tools (migration 0015)"
```

---

## Task 3: Schemas (`types.ts`) for the 21 DNS tools

**Files:** Modify `src/openprovider/types.ts`; Test `src/openprovider/types.test.ts` (append).

Reuse the existing local `DomainRef` (`{ name, extension }`) already in this file. Add shared record shapes + per-tool arg schemas.

- [ ] **Step 1: Write failing schema tests** (append to `src/openprovider/types.test.ts`):
```ts
import {
  CreateDnsZoneArgs, UpdateDnsZoneArgs, ZoneNameArg, CreateNameserverArgs,
  NameserverNameArg, CreateNsGroupArgs, NsGroupNameArg, CreateDnsTemplateArgs,
  TemplateIdArg, CreateDomainTokenArgs,
} from './types.js';
describe('batch2 DNS schemas', () => {
  it('CreateDnsZoneArgs requires domain+provider+type, records flat array', () => {
    expect(CreateDnsZoneArgs.safeParse({ domain: { name: 'x', extension: 'com' }, provider: 'openprovider', type: 'master', records: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] }).success).toBe(true);
    expect(CreateDnsZoneArgs.safeParse({ domain: { name: 'x', extension: 'com' } }).success).toBe(false);
  });
  it('UpdateDnsZoneArgs uses records.add/remove object', () => {
    expect(UpdateDnsZoneArgs.safeParse({ domain: { name: 'x', extension: 'com' }, records: { add: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] } }).success).toBe(true);
    expect(UpdateDnsZoneArgs.safeParse({ domain: { name: 'x', extension: 'com' }, records: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] }).success).toBe(false); // flat array invalid on update
  });
  it('ZoneNameArg / NameserverNameArg require name', () => {
    expect(ZoneNameArg.safeParse({ name: 'example.com' }).success).toBe(true);
    expect(ZoneNameArg.safeParse({}).success).toBe(false);
    expect(NameserverNameArg.safeParse({ name: 'ns1.example.com' }).success).toBe(true);
  });
  it('CreateNameserverArgs requires name+ip', () => {
    expect(CreateNameserverArgs.safeParse({ name: 'ns1.x.com', ip: '1.2.3.4' }).success).toBe(true);
    expect(CreateNameserverArgs.safeParse({ name: 'ns1.x.com' }).success).toBe(false);
  });
  it('CreateNsGroupArgs requires ns_group + name_servers', () => {
    expect(CreateNsGroupArgs.safeParse({ ns_group: 'G', name_servers: [{ name: 'ns1.x.com', ip: '1.2.3.4', seq_nr: 0 }] }).success).toBe(true);
    expect(CreateNsGroupArgs.safeParse({ ns_group: 'G', name_servers: [] }).success).toBe(false);
  });
  it('NsGroupNameArg requires ns_group', () => {
    expect(NsGroupNameArg.safeParse({ ns_group: 'G' }).success).toBe(true);
    expect(NsGroupNameArg.safeParse({}).success).toBe(false);
  });
  it('CreateDnsTemplateArgs requires name', () => {
    expect(CreateDnsTemplateArgs.safeParse({ name: 'T', records: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] }).success).toBe(true);
    expect(CreateDnsTemplateArgs.safeParse({}).success).toBe(false);
  });
  it('TemplateIdArg requires positive int id', () => {
    expect(TemplateIdArg.safeParse({ id: 5 }).success).toBe(true);
    expect(TemplateIdArg.safeParse({ id: -1 }).success).toBe(false);
  });
  it('CreateDomainTokenArgs requires domain + zone_provider', () => {
    expect(CreateDomainTokenArgs.safeParse({ domain: 'x.com', zone_provider: 'openprovider' }).success).toBe(true);
    expect(CreateDomainTokenArgs.safeParse({ domain: 'x.com' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Add the schemas to `src/openprovider/types.ts`:**
```ts
const DnsRecord = z.object({
  name: z.string().optional(),
  type: z.string().min(1),
  value: z.string().min(1),
  ttl: z.number().int().positive(),
  prio: z.number().int().nonnegative().optional(),
});

// --- path-only arg schemas ---
export const ZoneNameArg = z.object({ name: z.string().min(1) });
export const NameserverNameArg = z.object({ name: z.string().min(1) });
export const NsGroupNameArg = z.object({ ns_group: z.string().min(1) });
export const TemplateIdArg = z.object({ id: z.number().int().positive() });
export const NoArgs = z.object({}); // list endpoints

// --- zones ---
export const CreateDnsZoneArgs = z.object({
  domain: DomainRef,
  provider: z.string().min(1),
  type: z.enum(['master', 'slave']),
  master_ip: z.string().optional(),
  secured: z.boolean().optional(),
  template_name: z.string().optional(),
  is_spamexperts_enabled: z.boolean().optional(),
  records: z.array(DnsRecord).optional(),
});
export const UpdateDnsZoneArgs = z.object({
  domain: DomainRef, // required: used to derive the :name path param
  provider: z.string().min(1).optional(),
  type: z.enum(['master', 'slave']).optional(),
  master_ip: z.string().optional(),
  secured: z.boolean().optional(),
  dnskey: z.boolean().optional(),
  template_name: z.string().optional(),
  is_spamexperts_enabled: z.boolean().optional(),
  records: z.object({
    add: z.array(DnsRecord).optional(),
    remove: z.array(DnsRecord).optional(),
  }).optional(),
});

// --- nameservers ---
export const CreateNameserverArgs = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  ip6: z.string().optional(),
});
export const UpdateNameserverArgs = CreateNameserverArgs; // same body; name used for path

// --- ns groups ---
const NsGroupMember = z.object({
  id: z.number().int().nonnegative().optional(),
  name: z.string().min(1),
  ip: z.string().min(1),
  ip6: z.string().optional(),
  seq_nr: z.number().int().nonnegative(),
});
export const CreateNsGroupArgs = z.object({
  ns_group: z.string().min(1),
  name_servers: z.array(NsGroupMember).min(1),
});
export const UpdateNsGroupArgs = CreateNsGroupArgs; // full-replace; ns_group used for path

// --- templates ---
const DnsTemplateRecord = z.object({
  id: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
  type: z.string().min(1),
  value: z.string().min(1), // may contain the %domain% placeholder
  ttl: z.number().int().positive(),
  prio: z.number().int().nonnegative().optional(),
});
export const CreateDnsTemplateArgs = z.object({
  name: z.string().min(1),
  is_spamexperts_enabled: z.boolean().optional(),
  records: z.array(DnsTemplateRecord).optional(),
});

// --- domain token ---
export const CreateDomainTokenArgs = z.object({
  domain: z.string().min(1),
  zone_provider: z.string().min(1),
});
```
Add `export type Xxx = z.infer<typeof Xxx>` for each new schema (match the file's existing pattern). NOTE: `UpdateNameserverArgs = CreateNameserverArgs` and `UpdateNsGroupArgs = CreateNsGroupArgs` are intentional aliases (identical bodies); if the file's lint dislikes the `z.infer` of an alias, define them as fresh `z.object` copies instead.

- [ ] **Step 4: Run → pass.** `npm run typecheck`.
- [ ] **Step 5: Commit** `git add src/openprovider/types.ts src/openprovider/types.test.ts && git commit -m "feat(op-batch2): zod schemas for DNS tools"`.

---

## Task 4: `OpenproviderClient` methods + Nock unit tests

**Files:** Modify `src/openprovider/client.ts` (+ interface); Test `src/openprovider/client.test.ts` (append).

> **IMPORTANT — interface growth cascade:** adding 21 methods to the `OpenproviderClient` interface will break every mock-client object typed as `OpenproviderClient` (Batch 1 hit this in `pricing.test.ts` + tool test files). After implementing, run `npm run typecheck` and add `vi.fn()` stubs for all 21 new methods to EVERY failing mock (e.g. `src/policies/pricing.test.ts`'s `clientWith`, `src/tools/*.test.ts` mock clients). Commit those mock fixes together with this task.

- [ ] **Step 1: Add failing Nock tests** (append to `src/openprovider/client.test.ts`; reuse the file's existing `BASE`/`PREFIX` consts). One per method; for write paths add a body matcher. Examples:
```ts
it('listDnsZones GETs /dns/zones', async () => {
  nock(BASE).get(`${PREFIX}/dns/zones`).reply(200, { data: [] });
  expect(await createOpenproviderClient().listDnsZones('tok')).toEqual([]);
});
it('getDnsZone GETs /dns/zones/:name (encoded)', async () => {
  nock(BASE).get(`${PREFIX}/dns/zones/example.com`).reply(200, { data: { name: 'example.com' } });
  expect(await createOpenproviderClient().getDnsZone('tok', 'example.com')).toEqual({ name: 'example.com' });
});
it('createDnsZone POSTs /dns/zones with flat records', async () => {
  nock(BASE).post(`${PREFIX}/dns/zones`, (b) => Array.isArray((b as any).records)).reply(200, { data: { id: 1 } });
  expect(await createOpenproviderClient().createDnsZone('tok', { domain: { name: 'x', extension: 'com' }, provider: 'openprovider', type: 'master', records: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] })).toEqual({ id: 1 });
});
it('updateDnsZone PUTs /dns/zones/:name derived from domain', async () => {
  nock(BASE).put(`${PREFIX}/dns/zones/x.com`, (b) => typeof (b as any).records === 'object' && !Array.isArray((b as any).records)).reply(200, { data: { ok: true } });
  expect(await createOpenproviderClient().updateDnsZone('tok', { domain: { name: 'x', extension: 'com' }, records: { add: [{ type: 'A', value: '1.2.3.4', ttl: 3600 }] } })).toEqual({ ok: true });
});
it('deleteDnsZone DELETEs /dns/zones/:name', async () => {
  nock(BASE).delete(`${PREFIX}/dns/zones/x.com`).reply(200, { data: { ok: true } });
  expect(await createOpenproviderClient().deleteDnsZone('tok', 'x.com')).toEqual({ ok: true });
});
it('getDnsTemplate GETs /dns/templates/:id', async () => {
  nock(BASE).get(`${PREFIX}/dns/templates/7`).reply(200, { data: { id: 7 } });
  expect(await createOpenproviderClient().getDnsTemplate('tok', 7)).toEqual({ id: 7 });
});
it('createNsGroup POSTs /dns/nameservers/groups', async () => {
  nock(BASE).post(`${PREFIX}/dns/nameservers/groups`).reply(200, { data: { ok: true } });
  expect(await createOpenproviderClient().createNsGroup('tok', { ns_group: 'G', name_servers: [{ name: 'ns1.x.com', ip: '1.2.3.4', seq_nr: 0 }] })).toEqual({ ok: true });
});
it('createDomainToken POSTs /dns/domain-token', async () => {
  nock(BASE).post(`${PREFIX}/dns/domain-token`).reply(200, { data: { token: 't' } });
  expect(await createOpenproviderClient().createDomainToken('tok', { domain: 'x.com', zone_provider: 'openprovider' })).toEqual({ token: 't' });
});
```
Add the remaining tests: `listDnsZoneRecords`, `listNameservers`, `getNameserver`, `createNameserver`, `updateNameserver`, `deleteNameserver`, `listNsGroups`, `getNsGroup`, `updateNsGroup`, `deleteNsGroup`, `listDnsTemplates`, `createDnsTemplate`, `deleteDnsTemplate` — each asserting verb+path+unwrapped data.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement the 21 methods** on the returned object + interface signatures. Pattern (parse args for arg-methods; encode string path params; derive write path from a parsed field):
```ts
    async listDnsZones(token) {
      const b = await request('GET', '/dns/zones', token);
      return (b as { data?: unknown }).data ?? b;
    },
    async getDnsZone(token, name) {
      const b = await request('GET', `/dns/zones/${encodeURIComponent(name)}`, token);
      return (b as { data?: unknown }).data ?? b;
    },
    async createDnsZone(token, args) {
      const parsed = CreateDnsZoneArgs.parse(args);
      const b = await request('POST', '/dns/zones', token, parsed);
      return (b as { data?: unknown }).data ?? b;
    },
    async updateDnsZone(token, args) {
      const parsed = UpdateDnsZoneArgs.parse(args);
      const name = `${parsed.domain.name}.${parsed.domain.extension}`;
      const b = await request('PUT', `/dns/zones/${encodeURIComponent(name)}`, token, parsed);
      return (b as { data?: unknown }).data ?? b;
    },
    async deleteDnsZone(token, name) {
      const b = await request('DELETE', `/dns/zones/${encodeURIComponent(name)}`, token);
      return (b as { data?: unknown }).data ?? b;
    },
    async listDnsZoneRecords(token, name) {
      const b = await request('GET', `/dns/zones/${encodeURIComponent(name)}/records`, token);
      return (b as { data?: unknown }).data ?? b;
    },
    async listNameservers(token) { /* GET /dns/nameservers */ },
    async getNameserver(token, name) { /* GET /dns/nameservers/${encodeURIComponent(name)} */ },
    async createNameserver(token, args) { const parsed = CreateNameserverArgs.parse(args); /* POST /dns/nameservers body=parsed */ },
    async updateNameserver(token, args) { const parsed = UpdateNameserverArgs.parse(args); /* PUT /dns/nameservers/${encodeURIComponent(parsed.name)} body=parsed */ },
    async deleteNameserver(token, name) { /* DELETE /dns/nameservers/${encodeURIComponent(name)} */ },
    async listNsGroups(token) { /* GET /dns/nameservers/groups */ },
    async getNsGroup(token, nsGroup) { /* GET /dns/nameservers/groups/${encodeURIComponent(nsGroup)} */ },
    async createNsGroup(token, args) { const parsed = CreateNsGroupArgs.parse(args); /* POST /dns/nameservers/groups body=parsed */ },
    async updateNsGroup(token, args) { const parsed = UpdateNsGroupArgs.parse(args); /* PUT /dns/nameservers/groups/${encodeURIComponent(parsed.ns_group)} body=parsed */ },
    async deleteNsGroup(token, nsGroup) { /* DELETE /dns/nameservers/groups/${encodeURIComponent(nsGroup)} */ },
    async listDnsTemplates(token) { /* GET /dns/templates */ },
    async getDnsTemplate(token, id) { /* GET /dns/templates/${id} */ },
    async createDnsTemplate(token, args) { const parsed = CreateDnsTemplateArgs.parse(args); /* POST /dns/templates body=parsed */ },
    async deleteDnsTemplate(token, id) { /* DELETE /dns/templates/${id} */ },
    async createDomainToken(token, args) { const parsed = CreateDomainTokenArgs.parse(args); /* POST /dns/domain-token body=parsed */ },
```
Each body uses the same `const b = await request(...); return (b as { data?: unknown }).data ?? b;` unwrap (fill in the commented bodies following the explicit examples above). Interface signatures: list → `(token: string): Promise<unknown>`; path-name → `(token: string, name: string): Promise<unknown>`; ns-group path → `(token: string, nsGroup: string)`; template path → `(token: string, id: number)`; arg-methods → `(token: string, args: XxxArgs): Promise<unknown>`. Import the new arg types from `./types.js`.

- [ ] **Step 4: Run → fail-then-fix the mock cascade.** Run `npx vitest run src/openprovider/client.test.ts` (green) then `npm run typecheck` — fix EVERY mock-client object that now lacks the 21 methods (add `vi.fn()` stubs). Re-run `npm run typecheck` until 0 errors, then `npx vitest run` (full unit suite green).

- [ ] **Step 5: Commit** (include all touched mock files):
```bash
git add src/openprovider/client.ts src/openprovider/client.test.ts <every mock test file you fixed>
git commit -m "feat(op-batch2): OpenproviderClient DNS methods"
```

---

## Task 5: Read tool factories (9)

**Files:** Create `src/tools/{list-dns-zones,get-dns-zone,list-dns-zone-records,list-nameservers,get-nameserver,list-ns-groups,get-ns-group,list-dns-templates,get-dns-template}.ts`; Modify `src/mcp/tool-catalog.ts`, `src/server.ts`, `src/mcp/tool-catalog.test.ts`.

Mirror the Batch-1 read exemplars `src/tools/get-domain-authcode.ts` (path-arg) and `src/tools/suggest-domain.ts` (body-arg). deps `{ client, tokenManager }`; handler parses args → gets token → calls client.

- [ ] **Step 1: Create the 9 factories.** name / factory / inputSchema / handler-call:
  - `list_dns_zones` / `createListDnsZonesTool` / `NoArgs` / `client.listDnsZones(token)` — desc "List all DNS zones."
  - `get_dns_zone` / `createGetDnsZoneTool` / `ZoneNameArg` / `client.getDnsZone(token, parsed.name)` — desc "Get a DNS zone by domain name."
  - `list_dns_zone_records` / `createListDnsZoneRecordsTool` / `ZoneNameArg` / `client.listDnsZoneRecords(token, parsed.name)` — desc "List the DNS records of a zone."
  - `list_nameservers` / `createListNameserversTool` / `NoArgs` / `client.listNameservers(token)` — desc "List nameservers."
  - `get_nameserver` / `createGetNameserverTool` / `NameserverNameArg` / `client.getNameserver(token, parsed.name)` — desc "Get a nameserver by name."
  - `list_ns_groups` / `createListNsGroupsTool` / `NoArgs` / `client.listNsGroups(token)` — desc "List nameserver groups."
  - `get_ns_group` / `createGetNsGroupTool` / `NsGroupNameArg` / `client.getNsGroup(token, parsed.ns_group)` — desc "Get a nameserver group by name."
  - `list_dns_templates` / `createListDnsTemplatesTool` / `NoArgs` / `client.listDnsTemplates(token)` — desc "List DNS templates."
  - `get_dns_template` / `createGetDnsTemplateTool` / `TemplateIdArg` / `client.getDnsTemplate(token, parsed.id)` — desc "Get a DNS template by id."
  - For `NoArgs` tools the handler still does `NoArgs.parse(args)` then calls the no-arg client method.
- [ ] **Step 2: Register** all 9 in `buildToolCatalog` (stub deps) + `dispatchFactory` (real deps `{ client: openproviderClient, tokenManager }`).
- [ ] **Step 3: Update `tool-catalog.test.ts`** — add the 9 names; count 23 → 32.
- [ ] **Step 4: Verify** `npm run typecheck` (0); `npx vitest run src/mcp/tool-catalog.test.ts`; `npx vitest run` (green).
- [ ] **Step 5: Commit** `git add src/tools/list-dns-zones.ts src/tools/get-dns-zone.ts src/tools/list-dns-zone-records.ts src/tools/list-nameservers.ts src/tools/get-nameserver.ts src/tools/list-ns-groups.ts src/tools/get-ns-group.ts src/tools/list-dns-templates.ts src/tools/get-dns-template.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch2): DNS read tools (zones/nameservers/ns-groups/templates)"`.

---

## Task 6: Allow-write tool factories (8)

**Files:** Create `src/tools/{create-dns-zone,update-dns-zone,create-nameserver,update-nameserver,create-ns-group,update-ns-group,create-dns-template,create-domain-token}.ts`; Modify `tool-catalog.ts`, `server.ts`, `tool-catalog.test.ts`.

Mirror `src/tools/reset-domain-authcode.ts` (body-arg allow tool). Handler: `const parsed = Schema.parse(args); const token = await deps.tokenManager.getToken(principal.tenantId); return deps.client.<method>(token, parsed);`.

- [ ] **Step 1: Create the 8 factories.** name / factory / inputSchema / client method:
  - `create_dns_zone` / `createCreateDnsZoneTool` / `CreateDnsZoneArgs` / `createDnsZone` — desc "Create a DNS zone."
  - `update_dns_zone` / `createUpdateDnsZoneTool` / `UpdateDnsZoneArgs` / `updateDnsZone` — desc "Update a DNS zone (add/remove records)."
  - `create_nameserver` / `createCreateNameserverTool` / `CreateNameserverArgs` / `createNameserver` — desc "Register a nameserver."
  - `update_nameserver` / `createUpdateNameserverTool` / `UpdateNameserverArgs` / `updateNameserver` — desc "Update a nameserver's IPs."
  - `create_ns_group` / `createCreateNsGroupTool` / `CreateNsGroupArgs` / `createNsGroup` — desc "Create a nameserver group."
  - `update_ns_group` / `createUpdateNsGroupTool` / `UpdateNsGroupArgs` / `updateNsGroup` — desc "Update a nameserver group (full replace)."
  - `create_dns_template` / `createCreateDnsTemplateTool` / `CreateDnsTemplateArgs` / `createDnsTemplate` — desc "Create a DNS template."
  - `create_domain_token` / `createCreateDomainTokenTool` / `CreateDomainTokenArgs` / `createDomainToken` — desc "Create a DNS domain-control token."
  All call `deps.client.<method>(token, parsed)`.
- [ ] **Step 2: Register** all 8 in catalog + dispatch (real deps).
- [ ] **Step 3: Update `tool-catalog.test.ts`** — add 8 names; count 32 → 40.
- [ ] **Step 4: Verify** typecheck (0); catalog test; full unit suite.
- [ ] **Step 5: Commit** `git add src/tools/create-dns-zone.ts src/tools/update-dns-zone.ts src/tools/create-nameserver.ts src/tools/update-nameserver.ts src/tools/create-ns-group.ts src/tools/update-ns-group.ts src/tools/create-dns-template.ts src/tools/create-domain-token.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch2): DNS write tools (create/update zone/nameserver/ns-group/template + domain-token)"`.

---

## Task 7: Confirm tool factories (4 deletes)

**Files:** Create `src/tools/{delete-dns-zone,delete-nameserver,delete-ns-group,delete-dns-template}.ts`; Modify `tool-catalog.ts`, `server.ts`, `tool-catalog.test.ts`.

Confirm gating is policy-driven (Task 2 modes) — factories are the plain parse→token→client shape (no confirm logic). Mirror `src/tools/delete-domain.ts`.

- [ ] **Step 1: Create the 4 factories.** name / factory / inputSchema / client call:
  - `delete_dns_zone` / `createDeleteDnsZoneTool` / `ZoneNameArg` / `client.deleteDnsZone(token, parsed.name)` — desc "Delete a DNS zone (destructive; requires approval)."
  - `delete_nameserver` / `createDeleteNameserverTool` / `NameserverNameArg` / `client.deleteNameserver(token, parsed.name)` — desc "Delete a nameserver (requires approval)."
  - `delete_ns_group` / `createDeleteNsGroupTool` / `NsGroupNameArg` / `client.deleteNsGroup(token, parsed.ns_group)` — desc "Delete a nameserver group (requires approval)."
  - `delete_dns_template` / `createDeleteDnsTemplateTool` / `TemplateIdArg` / `client.deleteDnsTemplate(token, parsed.id)` — desc "Delete a DNS template (requires approval)."
- [ ] **Step 2: Register** all 4 in catalog + dispatch (real deps).
- [ ] **Step 3: Update `tool-catalog.test.ts`** — add 4 names; count 40 → 44.
- [ ] **Step 4: Verify** typecheck (0); catalog test; full unit suite.
- [ ] **Step 5: Commit** `git add src/tools/delete-dns-zone.ts src/tools/delete-nameserver.ts src/tools/delete-ns-group.ts src/tools/delete-dns-template.ts src/mcp/tool-catalog.ts src/mcp/tool-catalog.test.ts src/server.ts && git commit -m "feat(op-batch2): DNS delete tools (confirm-mode)"`.

---

## Task 8: Integration test + full gate + commit

**Files:** Create `tests/integration/mcp/dns-e2e.test.ts`.

Model on `tests/integration/mcp/domain-lifecycle-e2e.test.ts` (the proven Batch-1 dispatch+policy harness). Seed a tenant; no OP creds connected. Assert:

- [ ] **Step 1: Write the test.**
  1. `buildToolCatalog()` / `tools/list` includes all 21 new DNS names.
  2. An **allow read** (`list_dns_zones`) for an operator → reaches handler → `openprovider_not_connected` (the Batch-1 discriminator: `error.data.code === 'openprovider_not_connected'`).
  3. An **allow write** (`create_dns_zone` with a valid body) for an operator → reaches handler → `openprovider_not_connected` (proves allow, no confirm).
  4. A **confirm** tool (`delete_dns_zone` with `{ name: 'x.com' }`) for an operator → returns the confirmation-proposal shape (`confirmationId`/`confirmationToken`/`expiresAt`/`requiredApproverRoles`), NOT executed.
  5. **Viewer gate:** a viewer calling `delete_dns_zone` → `error.data.code === 'policy_denied'`; a viewer calling `list_dns_zones` (read) → reaches handler (`openprovider_not_connected`).
  Use the exact harness wiring + discriminators from `domain-lifecycle-e2e.test.ts`.

- [ ] **Step 2: Run → pass** `npx vitest run --config vitest.integration.config.ts tests/integration/mcp/dns-e2e.test.ts` (patient on boot).

- [ ] **Step 3: FULL gate** — `npm run typecheck` (0), `npm run lint` (0), `npx vitest run` (unit green), `npx vitest run --config vitest.integration.config.ts` (integration green; live skips OK; the pre-existing `audit-chain` concurrency test may flake in parallel — re-run in isolation to confirm it's unrelated). Catalog test must equal 44.

- [ ] **Step 4: Commit + STOP** (do NOT push):
```bash
git add tests/integration/mcp/dns-e2e.test.ts
git commit -m "test(op-batch2): DNS dispatch + policy integration"
```

---

## Self-Review

**1. Spec coverage:** All 21 Batch-2 tools (9 reads, 8 allow-writes, 4 deletes) → Tasks 5/6/7; `ruleFor` longest-prefix fix → Task 1; DEFAULT_POLICY + migration → Task 2; schemas → Task 3; client methods → Task 4; integration → Task 8. DNS-record mutation via `update_dns_zone`'s `{add,remove}` payload is modeled (UpdateDnsZoneArgs.records object) — matches the spec note that records are edited through the zone update. ✅

**2. Placeholder scan:** No TBD/TODO. The repetitive client methods (Task 4) and factories (Tasks 5-7) give the full pattern with complete examples + each tool's exact name/schema/method/path/description — an engineer can produce each verbatim. The commented method bodies in Task 4 are filled by copying the explicit unwrap pattern shown directly above them. Not placeholders.

**3. Type consistency:** Schema names (`CreateDnsZoneArgs`, `UpdateDnsZoneArgs`, `ZoneNameArg`, `NameserverNameArg`, `NsGroupNameArg`, `TemplateIdArg`, `NoArgs`, `CreateNameserverArgs`, `UpdateNameserverArgs`, `CreateNsGroupArgs`, `UpdateNsGroupArgs`, `CreateDnsTemplateArgs`, `CreateDomainTokenArgs`) are consistent across Tasks 3→4→5/6/7. Client method names (`listDnsZones`, `getDnsZone`, `createDnsZone`, `updateDnsZone`, `deleteDnsZone`, `listDnsZoneRecords`, `listNameservers`, `getNameserver`, `createNameserver`, `updateNameserver`, `deleteNameserver`, `listNsGroups`, `getNsGroup`, `createNsGroup`, `updateNsGroup`, `deleteNsGroup`, `listDnsTemplates`, `getDnsTemplate`, `createDnsTemplate`, `deleteDnsTemplate`, `createDomainToken`) match Task 4 → factories. Tool names match DEFAULT_POLICY keys (Task 2). Catalog grows 23 → 32 → 40 → 44. ✅

**Known decisions (flag for reviewers):** (a) `update_dns_zone`/`update_nameserver`/`update_ns_group` derive their path identifier from a required body field (`domain`/`name`/`ns_group`) — consistent with the Batch-1 `(token,args)` contract. (b) On `update_dns_zone`, `provider`/`type` are optional (partial update) while `domain` is required (needed for the path); if OP rejects partial updates, a follow-up can make them required. (c) `ns_group` member `id` is optional (callers pass `0`/omit for new members per OP convention). (d) String path params are `encodeURIComponent`-encoded.

*End of plan.*

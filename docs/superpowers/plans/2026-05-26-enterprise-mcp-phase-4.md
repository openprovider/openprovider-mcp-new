# Enterprise Openprovider MCP — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the policy engine, content-bound confirmation flow, and atomic spend-reservation accounting (lazy, worker-free) — proven via a synthetic confirm-mode test tool and the real `list_pending_confirmations` / `confirm_pending` meta-tools — plus a default-on-provision policy and a `policy:set`/`policy:show` CLI.

**Architecture:** A pure `policies/engine` decides allow/deny/requires_confirmation. A `policies/repo` does the money-critical work in one transaction: `SELECT … FOR UPDATE` the tenant's policy row, compute live spend from `spend_reservations` (filtered by `expires_at`), insert a confirmation + pending reservation on propose, and commit/release on consume. The dispatcher gains a confirm-mode branch driven by injected collaborators. All money math is integer **cents**.

**Tech Stack:** unchanged (Fastify 4, Drizzle, pg, zod, Vitest, testcontainers, nock). No new dependencies — pg-boss is NOT introduced this phase.

**Spec:** `docs/superpowers/specs/2026-05-26-phase4-policy-confirmations-design.md`
**Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §4, §6
**Branch:** stacks on `feat/enterprise-phase-1`. **NEVER push** — orchestrator pushes after user confirmation.

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/0008_policies_confirmations_reservations.sql` (new) | 3 tables + RLS + grants; `CREATE OR REPLACE` `resolve_or_provision_tenant` to also seed the default policy |
| `src/policies/schema.ts` (new) | `PolicyDoc` zod schema, `RoleEnum`, `ModeEnum`, `DEFAULT_POLICY`, `requiredApproverRoles(policy, tool)` helper |
| `src/policies/money.ts` (new) | `eurToCents`, `centsToEur`, `parseEurString` |
| `src/policies/engine.ts` (new) | pure `evaluate(input): Decision` |
| `src/policies/pricing.ts` (new) | `createPricing({client})` → `price(tool, args, token)` cents, 24h cache, premium bypass, drift constant |
| `src/policies/repo.ts` (new) | `getPolicy`, `upsertPolicy`, `liveSpendCents`, `proposeConfirmation` (FOR UPDATE), `consumeConfirmation` |
| `src/mcp/dispatch.ts` (mod) | confirm-mode branch via injected `ConfirmDeps` |
| `src/tools/list-pending-confirmations.ts`, `src/tools/confirm-pending.ts` (new) | meta-tools |
| `src/server.ts` (mod) | wire `ConfirmDeps` into dispatchFactory; register meta-tools |
| `scripts/policy.ts` (new) | `policy:show` / `policy:set` CLI |
| `tests/...` | unit + integration + e2e per spec §10 |

**Task order:** schema-less pure modules first (money, schema, engine, pricing) so they're testable in isolation; then the migration; then the repo (needs DB); then dispatcher wiring; then meta-tools; then CLI; then the marquee concurrency integration test; then e2e + docs/tag.

---

## Task 1: Money helpers (integer cents)

**Files:**
- Create: `src/policies/money.ts`
- Create: `src/policies/money.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { eurToCents, centsToEur, parseEurString } from './money.js';

describe('money', () => {
  it('eurToCents rounds to nearest cent', () => {
    expect(eurToCents(12.99)).toBe(1299);
    expect(eurToCents(0)).toBe(0);
    expect(eurToCents(9.005)).toBe(901); // round half up at cent
  });
  it('centsToEur returns a 2-decimal number', () => {
    expect(centsToEur(1299)).toBe(12.99);
    expect(centsToEur(0)).toBe(0);
  });
  it('parseEurString parses pg numeric strings to cents', () => {
    expect(parseEurString('12.9900')).toBe(1299);
    expect(parseEurString('0')).toBe(0);
    expect(parseEurString(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- policies/money`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/policies/money.ts`**

```ts
export function eurToCents(eur: number): number {
  return Math.round(eur * 100);
}

export function centsToEur(cents: number): number {
  return Math.round(cents) / 100;
}

export function parseEurString(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return Math.round(parseFloat(value) * 100);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- policies/money`

- [ ] **Step 5: Commit**

```bash
git add src/policies/money.ts src/policies/money.test.ts
git commit -m "feat(phase4): integer-cents money helpers"
```

---

## Task 2: `PolicyDoc` schema + default + approver helper

**Files:**
- Create: `src/policies/schema.ts`
- Create: `src/policies/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { PolicyDoc, DEFAULT_POLICY, requiredApproverRoles, toolMode } from './schema.js';

describe('policy schema', () => {
  it('parses the default policy', () => {
    expect(() => PolicyDoc.parse(DEFAULT_POLICY)).not.toThrow();
    expect(DEFAULT_POLICY.spend_caps.limit_eur).toBe(0);
  });

  it('accepts a tool object form with approvers', () => {
    const doc = PolicyDoc.parse({
      ...DEFAULT_POLICY,
      tools: { ...DEFAULT_POLICY.tools, register_domain: { mode: 'confirm', approvers: ['owner'] } },
    });
    expect(requiredApproverRoles(doc, 'register_domain')).toEqual(['owner']);
  });

  it('defaults approver roles to owner+admin for bare confirm strings', () => {
    expect(requiredApproverRoles(DEFAULT_POLICY, 'register_domain')).toEqual(['owner', 'admin']);
  });

  it('resolves tool mode with exact > wildcard > deny', () => {
    expect(toolMode(DEFAULT_POLICY, 'list_domains')).toBe('allow'); // list_* wildcard
    expect(toolMode(DEFAULT_POLICY, 'check_domain')).toBe('allow'); // exact
    expect(toolMode(DEFAULT_POLICY, 'register_domain')).toBe('confirm');
    expect(toolMode(DEFAULT_POLICY, 'unknown_tool')).toBe('deny');
  });

  it('rejects an unknown spend window', () => {
    expect(() => PolicyDoc.parse({ ...DEFAULT_POLICY, spend_caps: { window: 'year', limit_eur: 1 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- policies/schema`

- [ ] **Step 3: Write `src/policies/schema.ts`**

```ts
import { z } from 'zod';

export const RoleEnum = z.enum(['owner', 'admin', 'operator', 'viewer']);
export type Role = z.infer<typeof RoleEnum>;

export const ModeEnum = z.enum(['allow', 'confirm']);
export type Mode = z.infer<typeof ModeEnum>;

const ToolRule = z.union([
  ModeEnum,
  z.object({ mode: ModeEnum, approvers: z.array(RoleEnum).optional() }),
]);

export const PolicyDoc = z.object({
  version: z.number().int().default(1),
  spend_caps: z.object({
    window: z.literal('month'),
    limit_eur: z.number().min(0),
  }),
  tld_allowlist: z.array(z.string()).default([]),
  tld_denylist: z.array(z.string()).default([]),
  tools: z.record(z.string(), ToolRule),
  ip_allowlist: z.array(z.string()).default([]),
});
export type PolicyDoc = z.infer<typeof PolicyDoc>;

export const DEFAULT_POLICY: PolicyDoc = {
  version: 1,
  spend_caps: { window: 'month', limit_eur: 0 },
  tld_allowlist: [],
  tld_denylist: [],
  tools: {
    'list_*': 'allow',
    'get_*': 'allow',
    check_domain: 'allow',
    register_domain: 'confirm',
    update_domain: 'confirm',
    delete_contact: 'confirm',
    update_contact: 'confirm',
    create_contact: 'allow',
  },
  ip_allowlist: [],
};

const DEFAULT_APPROVERS: Role[] = ['owner', 'admin'];

function ruleFor(policy: PolicyDoc, tool: string): z.infer<typeof ToolRule> | undefined {
  if (policy.tools[tool] !== undefined) return policy.tools[tool];
  // wildcard: longest matching prefix ending in '*'
  for (const [key, rule] of Object.entries(policy.tools)) {
    if (key.endsWith('*') && tool.startsWith(key.slice(0, -1))) return rule;
  }
  return undefined;
}

export function toolMode(policy: PolicyDoc, tool: string): Mode | 'deny' {
  const rule = ruleFor(policy, tool);
  if (rule === undefined) return 'deny';
  return typeof rule === 'string' ? rule : rule.mode;
}

export function requiredApproverRoles(policy: PolicyDoc, tool: string): Role[] {
  const rule = ruleFor(policy, tool);
  if (rule && typeof rule === 'object' && rule.approvers) return rule.approvers;
  return DEFAULT_APPROVERS;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- policies/schema`

- [ ] **Step 5: Commit**

```bash
git add src/policies/schema.ts src/policies/schema.test.ts
git commit -m "feat(phase4): PolicyDoc zod schema, default policy, tool-mode + approver helpers"
```

---

## Task 3: `policies/engine` — pure decision

**Files:**
- Create: `src/policies/engine.ts`
- Create: `src/policies/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluate } from './engine.js';
import { DEFAULT_POLICY, type PolicyDoc } from './schema.js';

const base = {
  args: {},
  role: 'owner' as const,
  liveSpendCents: 0,
  estimatedCostCents: 0,
  tldsInArgs: [] as string[],
};

describe('policies/engine', () => {
  it('allows an allow-mode read tool', () => {
    expect(evaluate({ ...base, toolName: 'check_domain', policy: DEFAULT_POLICY })).toEqual({ decision: 'allow' });
  });

  it('denies an unknown tool', () => {
    expect(evaluate({ ...base, toolName: 'nope', policy: DEFAULT_POLICY }).decision).toBe('deny');
  });

  it('requires confirmation for a confirm-mode tool within cap', () => {
    const policy: PolicyDoc = { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 } };
    expect(
      evaluate({ ...base, toolName: 'register_domain', estimatedCostCents: 1299, policy, tldsInArgs: ['com'] }).decision,
    ).toBe('requires_confirmation');
  });

  it('denies when spend would exceed the cap', () => {
    const policy: PolicyDoc = { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 10 } };
    const d = evaluate({ ...base, toolName: 'register_domain', liveSpendCents: 900, estimatedCostCents: 200, policy, tldsInArgs: ['com'] });
    expect(d).toEqual({ decision: 'deny', reason: 'spend_cap_exceeded' });
  });

  it('denies a denylisted TLD', () => {
    const policy: PolicyDoc = { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 }, tld_denylist: ['xxx'] };
    expect(
      evaluate({ ...base, toolName: 'register_domain', estimatedCostCents: 100, policy, tldsInArgs: ['xxx'] }).decision,
    ).toBe('deny');
  });

  it('denies a TLD outside a non-empty allowlist', () => {
    const policy: PolicyDoc = { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 }, tld_allowlist: ['com'] };
    expect(
      evaluate({ ...base, toolName: 'register_domain', estimatedCostCents: 100, policy, tldsInArgs: ['net'] }).decision,
    ).toBe('deny');
  });

  it('viewer cannot invoke a confirm-mode write', () => {
    const policy: PolicyDoc = { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 } };
    expect(evaluate({ ...base, role: 'viewer', toolName: 'register_domain', policy, tldsInArgs: ['com'] }).decision).toBe('deny');
  });

  it('property: cap decision is monotonic in estimated cost', () => {
    const policy: PolicyDoc = { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 } };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20000 }), (cost) => {
        const d = evaluate({ ...base, toolName: 'register_domain', estimatedCostCents: cost, policy, tldsInArgs: ['com'] });
        if (cost <= 10000) return d.decision === 'requires_confirmation';
        return d.decision === 'deny';
      }),
    );
  });
});
```

Install fast-check if absent: `npm install --save-dev fast-check`.

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- policies/engine`

- [ ] **Step 3: Write `src/policies/engine.ts`**

```ts
import { toolMode, type PolicyDoc, type Role } from './schema.js';

export type Decision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'requires_confirmation' };

export interface EvaluateInput {
  toolName: string;
  args: unknown;
  role: Role;
  policy: PolicyDoc;
  liveSpendCents: number;
  estimatedCostCents: number;
  tldsInArgs: string[];
}

const READ_TOOLS = new Set(['check_domain', 'list_domains', 'get_domain', 'list_contacts', 'get_contact', 'list_pending_confirmations']);

export function evaluate(input: EvaluateInput): Decision {
  const mode = toolMode(input.policy, input.toolName);
  if (mode === 'deny') return { decision: 'deny', reason: 'tool_not_permitted' };

  // Role gate: viewer may only run allow-mode read tools.
  const isRead = READ_TOOLS.has(input.toolName);
  if (input.role === 'viewer' && !(mode === 'allow' && isRead)) {
    return { decision: 'deny', reason: 'insufficient_role' };
  }

  // TLD gate (domain tools only).
  if (input.tldsInArgs.length > 0) {
    const deny = input.policy.tld_denylist.map((t) => t.replace(/^\./, ''));
    const allow = input.policy.tld_allowlist.map((t) => t.replace(/^\./, ''));
    for (const raw of input.tldsInArgs) {
      const tld = raw.replace(/^\./, '');
      if (deny.includes(tld)) return { decision: 'deny', reason: 'tld_denied' };
      if (allow.length > 0 && !allow.includes(tld)) return { decision: 'deny', reason: 'tld_not_allowed' };
    }
  }

  // Spend gate (billable tools).
  if (input.estimatedCostCents > 0) {
    const limitCents = Math.round(input.policy.spend_caps.limit_eur * 100);
    if (input.liveSpendCents + input.estimatedCostCents > limitCents) {
      return { decision: 'deny', reason: 'spend_cap_exceeded' };
    }
  }

  return mode === 'confirm' ? { decision: 'requires_confirmation' } : { decision: 'allow' };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- policies/engine`

- [ ] **Step 5: Commit**

```bash
git add src/policies/engine.ts src/policies/engine.test.ts package.json package-lock.json
git commit -m "feat(phase4): pure policies/engine with TLD, role, and spend-cap gates + property test"
```

---

## Task 4: `policies/pricing` — price + 24h cache + drift constant

**Files:**
- Create: `src/policies/pricing.ts`
- Create: `src/policies/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPricing, DRIFT_TOLERANCE } from './pricing.js';

function clientWith(price: { price: number; currency: string } | undefined, isPremium = false) {
  return {
    checkDomain: vi.fn().mockResolvedValue({
      results: [{ domain: 'x.com', status: 'free', is_premium: isPremium, price: price ? { product: price } : undefined }],
    }),
    listDomains: vi.fn(), getDomain: vi.fn(), listContacts: vi.fn(), getContact: vi.fn(),
  };
}

describe('pricing', () => {
  it('prices register_domain in cents from check_domain', async () => {
    const client = clientWith({ price: 12.99, currency: 'EUR' });
    const pricing = createPricing({ client });
    const cents = await pricing.price('register_domain', { domain: { name: 'x', extension: 'com' }, period: 1 }, 'tok');
    expect(cents).toBe(1299);
  });

  it('returns 0 for non-billable confirm tools', async () => {
    const pricing = createPricing({ client: clientWith(undefined) });
    expect(await pricing.price('delete_contact', { id: 1 }, 'tok')).toBe(0);
  });

  it('throws unsupported_currency for non-EUR', async () => {
    const pricing = createPricing({ client: clientWith({ price: 5, currency: 'USD' }) });
    await expect(
      pricing.price('register_domain', { domain: { name: 'x', extension: 'com' }, period: 1 }, 'tok'),
    ).rejects.toMatchObject({ code: 'unsupported_currency' });
  });

  it('caches standard TLD prices (one upstream call for two prices)', async () => {
    const client = clientWith({ price: 10, currency: 'EUR' });
    const pricing = createPricing({ client });
    await pricing.price('register_domain', { domain: { name: 'a', extension: 'com' }, period: 1 }, 'tok');
    await pricing.price('register_domain', { domain: { name: 'b', extension: 'com' }, period: 1 }, 'tok');
    expect(client.checkDomain).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache for premium domains', async () => {
    const client = clientWith({ price: 999, currency: 'EUR' }, true);
    const pricing = createPricing({ client });
    await pricing.price('register_domain', { domain: { name: 'a', extension: 'com' }, period: 1 }, 'tok');
    await pricing.price('register_domain', { domain: { name: 'a', extension: 'com' }, period: 1 }, 'tok');
    expect(client.checkDomain).toHaveBeenCalledTimes(2);
  });

  it('exposes a 5% drift tolerance', () => {
    expect(DRIFT_TOLERANCE).toBeCloseTo(0.05);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- policies/pricing`

- [ ] **Step 3: Write `src/policies/pricing.ts`**

```ts
import type { OpenproviderClient } from '../openprovider/client.js';
import { eurToCents } from './money.js';

export const DRIFT_TOLERANCE = 0.05;

class UnsupportedCurrencyError extends Error {
  readonly code = 'unsupported_currency';
  constructor(currency: string) {
    super(`Unsupported currency: ${currency}. Phase 4 supports EUR only.`);
    this.name = 'UnsupportedCurrencyError';
  }
}

const BILLABLE = new Set(['register_domain', 'update_domain']);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface DomainArg { domain?: { name: string; extension: string }; period?: number;
  domains?: { name: string; extension: string }[]; }

export interface Pricing {
  price(toolName: string, args: unknown, token: string): Promise<number>;
}

export function createPricing(deps: { client: OpenproviderClient }): Pricing {
  const cache = new Map<string, { cents: number; at: number }>();

  async function priceOneTld(token: string, name: string, extension: string, period: number): Promise<number> {
    const key = `${extension}|${period}|EUR`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cents;

    const res = await deps.client.checkDomain(token, {
      domains: [{ name, extension }],
      with_price: true,
    });
    const row = res.results[0];
    const product = row?.price?.product;
    if (!product) return 0;
    if (product.currency !== 'EUR') throw new UnsupportedCurrencyError(product.currency);
    const cents = eurToCents(product.price) * period;
    // Premium domains are not cached (price is name-specific, not TLD-generic).
    if (!row?.is_premium) cache.set(key, { cents: eurToCents(product.price), at: Date.now() });
    return cents;
  }

  return {
    async price(toolName, args, token) {
      if (!BILLABLE.has(toolName)) return 0;
      const a = args as DomainArg;
      const period = a.period ?? 1;
      if (a.domain) return priceOneTld(token, a.domain.name, a.domain.extension, period);
      if (a.domains) {
        let total = 0;
        for (const d of a.domains) total += await priceOneTld(token, d.name, d.extension, period);
        return total;
      }
      return 0;
    },
  };
}
```

> Note: the premium-bypass test calls the same `(extension,period)` twice and expects 2 upstream calls. Because premium results are never cached, the second call misses → 2 calls. Standard (non-premium) results cache after the first → 1 call. The cache key is TLD-generic; premium prices are name-specific so caching them would be wrong.

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- policies/pricing`

- [ ] **Step 5: Commit**

```bash
git add src/policies/pricing.ts src/policies/pricing.test.ts
git commit -m "feat(phase4): pricing module — cents, 24h TLD cache, premium bypass, EUR-only"
```

---

## Task 5: Migration 0008 — tables + seed default policy in resolver

**Files:**
- Create: `migrations/0008_policies_confirmations_reservations.sql`
- Modify: `migrations/meta/_journal.json`

- [ ] **Step 1: Write `migrations/0008_policies_confirmations_reservations.sql`**

```sql
-- Policies
CREATE TABLE policies (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  doc                jsonb NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid
);
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
CREATE POLICY policies_isolation ON policies
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON policies TO app_role;

-- Confirmations
CREATE TABLE confirmations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  principal_subject       text NOT NULL,
  tool_name               text NOT NULL,
  args_hash               bytea NOT NULL,
  args_jsonb              jsonb NOT NULL,
  summary_text            text NOT NULL,
  estimated_cost_eur      numeric(12,4) NOT NULL DEFAULT 0,
  required_approver_roles text[] NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz
);
ALTER TABLE confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY confirmations_isolation ON confirmations
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON confirmations TO app_role;
CREATE UNIQUE INDEX confirmations_active_id ON confirmations (id) WHERE consumed_at IS NULL;
CREATE INDEX confirmations_tenant_expiry ON confirmations (tenant_id, expires_at);

-- Spend reservations
CREATE TABLE spend_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  confirmation_id uuid REFERENCES confirmations(id),
  amount_eur      numeric(12,4) NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','released')),
  window_start    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz
);
ALTER TABLE spend_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY spend_reservations_isolation ON spend_reservations
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON spend_reservations TO app_role;
CREATE INDEX spend_reservations_window ON spend_reservations (tenant_id, window_start, status);

-- Seed a default policy whenever a tenant is provisioned. CREATE OR REPLACE the
-- Phase 3 function to also insert the default policy row for the new tenant.
CREATE OR REPLACE FUNCTION resolve_or_provision_tenant(p_subject text, p_email text)
  RETURNS TABLE (tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_new_tenant_id uuid;
BEGIN
  LOOP
    RETURN QUERY
      SELECT u.tenant_id, u.id, u.role FROM users u WHERE u.oauth_subject = p_subject;
    IF FOUND THEN
      RETURN;
    END IF;

    BEGIN
      v_new_tenant_id := gen_random_uuid();
      INSERT INTO tenants (id, name)
        VALUES (v_new_tenant_id, 'tenant for ' || p_subject);
      INSERT INTO policies (tenant_id, doc)
        VALUES (
          v_new_tenant_id,
          '{"version":1,"spend_caps":{"window":"month","limit_eur":0},"tld_allowlist":[],"tld_denylist":[],"tools":{"list_*":"allow","get_*":"allow","check_domain":"allow","register_domain":"confirm","update_domain":"confirm","delete_contact":"confirm","update_contact":"confirm","create_contact":"allow"},"ip_allowlist":[]}'::jsonb
        );
      RETURN QUERY
        INSERT INTO users (tenant_id, email, oauth_subject, role)
        VALUES (v_new_tenant_id, NULLIF(p_email, ''), p_subject, 'owner')
        RETURNING users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- lost the race; subtransaction (incl. tenants + policies) rolled back. Loop.
    END;
  END LOOP;
END;
$$;
```

> The default-policy JSON here MUST match `DEFAULT_POLICY` in `src/policies/schema.ts` (Task 2). Task 6's repo also persists `DEFAULT_POLICY` lazily for any pre-existing tenant lacking a row, so both paths converge.

- [ ] **Step 2: Append journal entry to `migrations/meta/_journal.json`**

```json
{ "idx": 7, "version": "5", "when": 1748300000000, "tag": "0008_policies_confirmations_reservations", "breakpoints": true }
```

- [ ] **Step 3: Add Drizzle schema mirrors to `src/db/schema.ts`** (append; reuse existing imports + the `bytea` customType):

```ts
import { jsonb, numeric } from 'drizzle-orm/pg-core';

export const policies = pgTable('policies', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  doc: jsonb('doc').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
});

export const confirmations = pgTable('confirmations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  principalSubject: text('principal_subject').notNull(),
  toolName: text('tool_name').notNull(),
  argsHash: bytea('args_hash').notNull(),
  argsJsonb: jsonb('args_jsonb').notNull(),
  summaryText: text('summary_text').notNull(),
  estimatedCostEur: numeric('estimated_cost_eur').notNull().default('0'),
  requiredApproverRoles: text('required_approver_roles').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const spendReservations = pgTable('spend_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  confirmationId: uuid('confirmation_id').references(() => confirmations.id),
  amountEur: numeric('amount_eur').notNull(),
  status: text('status').notNull().default('pending'),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});
```

- [ ] **Step 4: Add a migration sanity integration test** `tests/integration/db/policies-migration.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';

describe('migration 0008 + default policy seeding', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('seeds a default policy when a tenant is provisioned', async () => {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)', ['sub_policy', 'p@example.com'],
      );
      const tenantId = r.rows[0]!.tenant_id;
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_role');
      await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);
      const p = await c.query<{ doc: { spend_caps: { limit_eur: number } } }>('SELECT doc FROM policies');
      expect(p.rows[0]?.doc.spend_caps.limit_eur).toBe(0);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});
```

- [ ] **Step 5: Run**

Run: `npm run test:integration -- policies-migration && npm run typecheck`
Expected: pass; typecheck clean. Also re-run `npm run test:integration -- resolve-provision` to confirm the function replacement didn't break Phase 3's tests.

- [ ] **Step 6: Commit**

```bash
git add migrations/0008_policies_confirmations_reservations.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/policies-migration.test.ts
git commit -m "feat(phase4): migration 0008 — policy/confirmation/reservation tables + seed default policy"
```

---

## Task 6: `policies/repo` — getPolicy / upsert / liveSpend / propose / consume

**Files:**
- Create: `src/policies/repo.ts`
- Create: `tests/integration/policies/repo.test.ts`

- [ ] **Step 1: Write `src/policies/repo.ts`**

```ts
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { PolicyDoc, DEFAULT_POLICY, requiredApproverRoles, type Role } from './schema.js';
import { parseEurString, centsToEur } from './money.js';

export function canonicalArgsHash(args: unknown, tenantId: string): Buffer {
  const canonical = JSON.stringify(args, Object.keys(args as object).sort());
  return createHash('sha256').update(canonical).update(tenantId).digest();
}

export interface ConfirmationRecord {
  id: string;
  toolName: string;
  summaryText: string;
  estimatedCostCents: number;
  requiredApproverRoles: Role[];
  expiresAt: Date;
}

/** Reads the tenant's policy; persists + returns DEFAULT_POLICY if no row exists. */
export async function getPolicy(client: pg.PoolClient, tenantId: string): Promise<PolicyDoc> {
  const r = await client.query<{ doc: unknown }>('SELECT doc FROM policies WHERE tenant_id = $1', [tenantId]);
  if (r.rows[0]) return PolicyDoc.parse(r.rows[0].doc);
  await client.query(
    `INSERT INTO policies (tenant_id, doc) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, JSON.stringify(DEFAULT_POLICY)],
  );
  return DEFAULT_POLICY;
}

export async function upsertPolicy(
  client: pg.PoolClient, tenantId: string, doc: PolicyDoc, userId?: string,
): Promise<void> {
  PolicyDoc.parse(doc);
  await client.query(
    `INSERT INTO policies (tenant_id, doc, version, updated_at, updated_by_user_id)
       VALUES ($1, $2, 1, now(), $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET doc = EXCLUDED.doc, version = policies.version + 1, updated_at = now(), updated_by_user_id = EXCLUDED.updated_by_user_id`,
    [tenantId, JSON.stringify(doc), userId ?? null],
  );
}

/** Live spend in cents for the current month window (committed + non-expired pending). */
export async function liveSpendCents(client: pg.PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(sr.amount_eur), 0)::text AS total
       FROM spend_reservations sr
      WHERE sr.tenant_id = $1
        AND sr.window_start = date_trunc('month', now())
        AND (sr.status = 'committed'
             OR (sr.status = 'pending'
                 AND EXISTS (SELECT 1 FROM confirmations c
                              WHERE c.id = sr.confirmation_id
                                AND c.expires_at > now() AND c.consumed_at IS NULL)))`,
    [tenantId],
  );
  return parseEurString(r.rows[0]?.total ?? '0');
}

export interface ProposeInput {
  client: pg.PoolClient;
  tenantId: string;
  principalSubject: string;
  toolName: string;
  args: unknown;
  summaryText: string;
  estimatedCostCents: number;
  requiredApproverRoles: Role[];
  ttlMs: number;
}

/** Inserts a confirmation + pending reservation. Caller has already SELECT…FOR UPDATE'd the policy row and run the engine. */
export async function proposeConfirmation(input: ProposeInput): Promise<ConfirmationRecord> {
  const argsHash = canonicalArgsHash(input.args, input.tenantId);
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const conf = await input.client.query<{ id: string }>(
    `INSERT INTO confirmations
       (tenant_id, principal_subject, tool_name, args_hash, args_jsonb, summary_text, estimated_cost_eur, required_approver_roles, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.tenantId, input.principalSubject, input.toolName, argsHash,
      JSON.stringify(input.args), input.summaryText,
      centsToEur(input.estimatedCostCents).toString(), input.requiredApproverRoles, expiresAt,
    ],
  );
  const id = conf.rows[0]!.id;
  await input.client.query(
    `INSERT INTO spend_reservations (tenant_id, confirmation_id, amount_eur, status, window_start)
     VALUES ($1,$2,$3,'pending', date_trunc('month', now()))`,
    [input.tenantId, id, centsToEur(input.estimatedCostCents).toString()],
  );
  return {
    id, toolName: input.toolName, summaryText: input.summaryText,
    estimatedCostCents: input.estimatedCostCents, requiredApproverRoles: input.requiredApproverRoles, expiresAt,
  };
}

export interface LoadedConfirmation {
  id: string; toolName: string; argsHash: Buffer; estimatedCostCents: number;
  requiredApproverRoles: Role[]; expiresAt: Date; consumedAt: Date | null; argsJsonb: unknown;
}

export async function loadConfirmation(client: pg.PoolClient, id: string): Promise<LoadedConfirmation | null> {
  const r = await client.query<{
    id: string; tool_name: string; args_hash: Buffer; estimated_cost_eur: string;
    required_approver_roles: string[]; expires_at: Date; consumed_at: Date | null; args_jsonb: unknown;
  }>(
    `SELECT id, tool_name, args_hash, estimated_cost_eur, required_approver_roles, expires_at, consumed_at, args_jsonb
       FROM confirmations WHERE id = $1`, [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, toolName: row.tool_name, argsHash: row.args_hash,
    estimatedCostCents: parseEurString(row.estimated_cost_eur),
    requiredApproverRoles: row.required_approver_roles as Role[],
    expiresAt: row.expires_at, consumedAt: row.consumed_at, argsJsonb: row.args_jsonb,
  };
}

/** Marks the confirmation consumed and the reservation committed (success) or released (failure). */
export async function settleConfirmation(
  client: pg.PoolClient, confirmationId: string, outcome: 'committed' | 'released',
): Promise<void> {
  if (outcome === 'committed') {
    await client.query('UPDATE confirmations SET consumed_at = now() WHERE id = $1', [confirmationId]);
  }
  await client.query(
    `UPDATE spend_reservations SET status = $2, settled_at = now() WHERE confirmation_id = $1 AND status = 'pending'`,
    [confirmationId, outcome],
  );
}

export { requiredApproverRoles };
```

- [ ] **Step 2: Write `tests/integration/policies/repo.test.ts`** (happy-path + the **marquee concurrency** test)

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { getPolicy, upsertPolicy, liveSpendCents, proposeConfirmation, loadConfirmation, settleConfirmation } from '../../../src/policies/repo.js';
import { DEFAULT_POLICY } from '../../../src/policies/schema.js';

const T = '00000000-0000-0000-0000-0000000000c1';

describe('policies/repo integration', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]); } finally { c.release(); }
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('getPolicy returns + persists default when none exists', async () => {
    await runAsTenant(pool, T, async (c) => {
      const p = await getPolicy(c, T);
      expect(p.spend_caps.limit_eur).toBe(0);
    });
  });

  it('propose inserts a confirmation + pending reservation counted in live spend', async () => {
    await runAsTenant(pool, T, async (c) => {
      await upsertPolicy(c, T, { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 } });
      const rec = await proposeConfirmation({
        client: c, tenantId: T, principalSubject: 's', toolName: 'register_domain',
        args: { domain: { name: 'a', extension: 'com' }, period: 1 }, summaryText: 'reg a.com',
        estimatedCostCents: 1500, requiredApproverRoles: ['owner', 'admin'], ttlMs: 300_000,
      });
      expect(rec.id).toBeTruthy();
      expect(await liveSpendCents(c, T)).toBe(1500);
    });
  });

  it('settled-released reservation drops out of live spend; committed stays', async () => {
    await runAsTenant(pool, T, async (c) => {
      const before = await liveSpendCents(c, T);
      const rec = await proposeConfirmation({
        client: c, tenantId: T, principalSubject: 's', toolName: 'register_domain',
        args: { domain: { name: 'b', extension: 'com' }, period: 1 }, summaryText: 'reg b.com',
        estimatedCostCents: 1000, requiredApproverRoles: ['owner'], ttlMs: 300_000,
      });
      await settleConfirmation(c, rec.id, 'released');
      expect(await liveSpendCents(c, T)).toBe(before); // released no longer counts
    });
  });

  it('MARQUEE: concurrent proposals never overshoot the cap', async () => {
    const TENANT = '00000000-0000-0000-0000-0000000000c2';
    const seed = await pool.connect();
    try {
      await seed.query(`INSERT INTO tenants (id,name) VALUES ($1,'race')`, [TENANT]);
    } finally { seed.release(); }
    // cap €100, each proposal €15 → at most 6 may hold pending (6*15=90 ≤ 100, 7*15=105 > 100).
    await runAsTenant(pool, TENANT, async (c) => {
      await upsertPolicy(c, TENANT, { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 } });
    });

    async function tryPropose(): Promise<'ok' | 'denied'> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_role');
        await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', TENANT]);
        await c.query('SELECT 1 FROM policies WHERE tenant_id = $1 FOR UPDATE', [TENANT]); // serialize
        const live = await liveSpendCents(c, TENANT);
        if (live + 1500 > 10000) { await c.query('COMMIT'); return 'denied'; }
        await proposeConfirmation({
          client: c, tenantId: TENANT, principalSubject: 's', toolName: 'register_domain',
          args: { domain: { name: 'r' + Math.random(), extension: 'com' }, period: 1 }, summaryText: 'r',
          estimatedCostCents: 1500, requiredApproverRoles: ['owner'], ttlMs: 300_000,
        });
        await c.query('COMMIT');
        return 'ok';
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    }

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => tryPropose()));
    const ok = outcomes.filter((o) => o === 'ok').length;
    expect(ok).toBe(6);
    await runAsTenant(pool, TENANT, async (c) => {
      expect(await liveSpendCents(c, TENANT)).toBe(9000); // 6 * 1500, never exceeds 10000
    });
  }, 30_000);
});
```

- [ ] **Step 3: Run, expect PASS**

Run: `npm run test:integration -- policies/repo`
Expected: all pass, including the marquee concurrency test (exactly 6 succeed).

- [ ] **Step 4: Exclude integration-only repo from unit coverage** — add `src/policies/repo.ts` to `vitest.config.ts` coverage exclude list (it's integration-tested).

- [ ] **Step 5: Commit**

```bash
git add src/policies/repo.ts tests/integration/policies/repo.test.ts vitest.config.ts
git commit -m "feat(phase4): policies/repo — FOR-UPDATE live spend + propose/consume + marquee overshoot test"
```

---

## Task 7: Confirm-mode branch in the dispatcher

**Files:**
- Modify: `src/mcp/dispatch.ts`
- Modify: `src/mcp/dispatch.test.ts`

- [ ] **Step 1: Extend the dispatcher with injected confirm collaborators**

Add to `src/mcp/dispatch.ts`:

```ts
import type { Role } from '../policies/schema.js';

export interface ProposeResult {
  confirmationId: string;
  confirmationToken: string;
  summary: string;
  estimatedCostEur: number;
  requiredApproverRoles: Role[];
  expiresAt: string;
}

export interface ConfirmDeps {
  // returns null → tool runs in allow mode; otherwise the resolved mode + handling
  resolveMode: (toolName: string, principal: Principal) => Promise<'allow' | 'confirm' | 'deny'>;
  propose: (input: { toolName: string; args: unknown; principal: Principal }) => Promise<
    { kind: 'denied'; reason: string } | { kind: 'proposed'; result: ProposeResult }
  >;
  consume: (input: { token: string; toolName: string; args: unknown; principal: Principal }) => Promise<
    { kind: 'error'; code: string } | { kind: 'ok' }
  >;
}

export interface DispatchInput {
  name: string;
  args: unknown;
  principal: Principal;
  confirm?: { token: string };
}
```

Update `DispatcherConfig` to accept an optional `confirm?: ConfirmDeps`. Update the dispatch function: after tool lookup + validation, if `config.confirm` is present and `resolveMode(name) === 'confirm'`:
- no `input.confirm` token → call `propose`; if `denied` throw `DispatchError('policy_denied', reason)`; else **return** the `proposed` result as the tool result (the MCP client sees `confirmation_required`). Audit `tool.call` (proposal).
- `input.confirm` token present → call `consume`; if `error` throw `DispatchError(code, code)`; else fall through to execute the handler (the actual tool work) and audit `tool.result`.

If `resolveMode === 'deny'` → `DispatchError('policy_denied','tool_not_permitted')`. If `allow` (or no `config.confirm`) → existing behavior.

The exact insertion: validate args first (existing), then the confirm branch, then the existing `audit tool.call` + `handler` + `audit tool.result`. For a propose, you return BEFORE calling the handler. For a consume-OK, you proceed to the handler.

- [ ] **Step 2: Add dispatcher unit tests** in `src/mcp/dispatch.test.ts` using fake `ConfirmDeps`:

```ts
it('confirm-mode tool without token returns confirmation_required (proposed)', async () => {
  const audit: AuditRow[] = [];
  const dispatch = createDispatcher({
    audit: (r) => { audit.push(r); return Promise.resolve(); },
    tools: [{ name: 'reg', description: 'x', inputSchema: z.object({ d: z.string() }), handler: () => Promise.resolve({ ran: true }) }],
    confirm: {
      resolveMode: () => Promise.resolve('confirm'),
      propose: () => Promise.resolve({ kind: 'proposed', result: {
        confirmationId: 'cf1', confirmationToken: 'ct1', summary: 's', estimatedCostEur: 12.99,
        requiredApproverRoles: ['owner'], expiresAt: new Date().toISOString(),
      } }),
      consume: () => Promise.resolve({ kind: 'ok' }),
    },
  });
  const r = await dispatch({ name: 'reg', args: { d: 'a.com' }, principal }) as { confirmationToken?: string; ran?: boolean };
  expect(r.confirmationToken).toBe('ct1');
  expect(r.ran).toBeUndefined(); // handler NOT executed on propose
});

it('confirm-mode tool with token executes the handler after consume', async () => {
  const dispatch = createDispatcher({
    audit: () => Promise.resolve(),
    tools: [{ name: 'reg', description: 'x', inputSchema: z.object({ d: z.string() }), handler: () => Promise.resolve({ ran: true }) }],
    confirm: {
      resolveMode: () => Promise.resolve('confirm'),
      propose: () => Promise.resolve({ kind: 'denied', reason: 'should not be called' }),
      consume: () => Promise.resolve({ kind: 'ok' }),
    },
  });
  const r = await dispatch({ name: 'reg', args: { d: 'a.com' }, principal, confirm: { token: 'ct1' } }) as { ran?: boolean };
  expect(r.ran).toBe(true);
});

it('policy_denied propose throws structured error', async () => {
  const dispatch = createDispatcher({
    audit: () => Promise.resolve(),
    tools: [{ name: 'reg', description: 'x', inputSchema: z.object({ d: z.string() }), handler: () => Promise.resolve({}) }],
    confirm: {
      resolveMode: () => Promise.resolve('confirm'),
      propose: () => Promise.resolve({ kind: 'denied', reason: 'spend_cap_exceeded' }),
      consume: () => Promise.resolve({ kind: 'ok' }),
    },
  });
  await expect(dispatch({ name: 'reg', args: { d: 'a.com' }, principal })).rejects.toMatchObject({ code: 'policy_denied' });
});
```

- [ ] **Step 3: Run, expect PASS**

Run: `npm test -- dispatch && npm run typecheck && npm run lint`

- [ ] **Step 4: Commit**

```bash
git add src/mcp/dispatch.ts src/mcp/dispatch.test.ts
git commit -m "feat(phase4): dispatcher confirm-mode branch (propose returns token; consume then executes)"
```

---

## Task 8: Meta-tools `list_pending_confirmations` + `confirm_pending`

**Files:**
- Create: `src/tools/list-pending-confirmations.ts`
- Create: `src/tools/confirm-pending.ts`
- Create: `tests/integration/tools/meta-tools.test.ts`

- [ ] **Step 1: Write `src/tools/list-pending-confirmations.ts`**

```ts
import { z } from 'zod';
import type pg from 'pg';
import type { Principal } from '../auth/principal.js';

export function createListPendingConfirmationsTool(deps: { getClient: () => pg.PoolClient }) {
  return {
    name: 'list_pending_confirmations',
    description: 'List pending confirmations awaiting approval that the caller may approve.',
    inputSchema: z.object({}),
    handler: async (_args: unknown, principal: Principal): Promise<unknown> => {
      const client = deps.getClient();
      const r = await client.query<{
        id: string; tool_name: string; summary_text: string; args_jsonb: unknown;
        estimated_cost_eur: string; principal_subject: string; created_at: Date; expires_at: Date;
        required_approver_roles: string[];
      }>(
        `SELECT id, tool_name, summary_text, args_jsonb, estimated_cost_eur, principal_subject, created_at, expires_at, required_approver_roles
           FROM confirmations
          WHERE consumed_at IS NULL AND expires_at > now()`,
      );
      // Filter to confirmations the caller's role may approve.
      return r.rows
        .filter((row) => row.required_approver_roles.includes(principal.role ?? ''))
        .map((row) => ({
          confirmation_id: row.id, tool_name: row.tool_name, summary: row.summary_text,
          args: row.args_jsonb, estimated_cost_eur: Number(row.estimated_cost_eur),
          proposer_subject: row.principal_subject, created_at: row.created_at, expires_at: row.expires_at,
        }));
    },
  };
}
```

> `principal.role` exists only on `kind:'user'` principals. The handler uses `principal.role ?? ''` — service principals (no role) match nothing, which is correct for Phase 4 (approval is a human action).

- [ ] **Step 2: Write `src/tools/confirm-pending.ts`**

```ts
import { z } from 'zod';
import type { Principal } from '../auth/principal.js';

export const ConfirmPendingArgs = z.object({
  confirmation_id: z.string().uuid(),
  args: z.unknown(),
});

export interface ConfirmPendingDeps {
  consume: (input: { confirmationId: string; args: unknown; principal: Principal }) => Promise<
    { kind: 'error'; code: string } | { kind: 'ok'; result: unknown }
  >;
}

export function createConfirmPendingTool(deps: ConfirmPendingDeps) {
  return {
    name: 'confirm_pending',
    description: 'Approve and execute a previously proposed confirmation by id.',
    inputSchema: ConfirmPendingArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ConfirmPendingArgs.parse(args);
      const out = await deps.consume({ confirmationId: parsed.confirmation_id, args: parsed.args, principal });
      if (out.kind === 'error') {
        throw Object.assign(new Error(out.code), { code: out.code });
      }
      return out.result;
    },
  };
}
```

- [ ] **Step 3: Write `tests/integration/tools/meta-tools.test.ts`** — exercises list + confirm against real DB (provision tenant, raise cap, propose via repo, list shows it for owner, confirm_pending by owner consumes it; by a viewer is rejected). Use the repo functions directly to set up confirmations, then drive the meta-tools' handlers. (Full code: mirror the repo.test.ts setup; assert `list_pending_confirmations` returns the row for an `owner` principal and `[]` for a `viewer`; assert `confirm_pending` with a wrong-role principal returns `approver_role_required` and with `owner` returns ok.)

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { upsertPolicy, proposeConfirmation, loadConfirmation, settleConfirmation, canonicalArgsHash } from '../../../src/policies/repo.js';
import { DEFAULT_POLICY } from '../../../src/policies/schema.js';
import { createListPendingConfirmationsTool } from '../../../src/tools/list-pending-confirmations.js';
import type { Principal } from '../../../src/auth/principal.js';

const T = '00000000-0000-0000-0000-0000000000d1';
const owner = (t: string): Principal => ({ kind: 'user', tenantId: t, userId: 'u', subject: 's', scopes: [], role: 'owner' });
const viewer = (t: string): Principal => ({ kind: 'user', tenantId: t, userId: 'u', subject: 's', scopes: [], role: 'viewer' });

describe('meta-tools integration', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url); pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]); } finally { c.release(); }
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('list_pending_confirmations shows the row to an owner, hides from a viewer', async () => {
    await runAsTenant(pool, T, async (c) => {
      await upsertPolicy(c, T, { ...DEFAULT_POLICY, spend_caps: { window: 'month', limit_eur: 100 } });
      await proposeConfirmation({
        client: c, tenantId: T, principalSubject: 's', toolName: 'register_domain',
        args: { domain: { name: 'a', extension: 'com' }, period: 1 }, summaryText: 'reg a.com',
        estimatedCostCents: 1200, requiredApproverRoles: ['owner', 'admin'], ttlMs: 300_000,
      });
      const tool = createListPendingConfirmationsTool({ getClient: () => c });
      const asOwner = (await tool.handler({}, owner(T))) as unknown[];
      expect(asOwner.length).toBe(1);
      const asViewer = (await tool.handler({}, viewer(T))) as unknown[];
      expect(asViewer.length).toBe(0);
    });
  });
});
```

(The `confirm_pending` happy/deny paths are covered end-to-end in Task 10's e2e; this integration test locks `list_pending_confirmations` role filtering.)

- [ ] **Step 4: Run, expect PASS**

Run: `npm run test:integration -- meta-tools && npm run typecheck && npm run lint`

- [ ] **Step 5: Add the meta-tool files to coverage-exclude if needed** (integration-tested). Update `vitest.config.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/list-pending-confirmations.ts src/tools/confirm-pending.ts tests/integration/tools/meta-tools.test.ts vitest.config.ts
git commit -m "feat(phase4): list_pending_confirmations + confirm_pending meta-tools"
```

---

## Task 9: Wire `ConfirmDeps` + meta-tools + policy seeding into `server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Build `ConfirmDeps` inside `dispatchFactory`** (which already holds a per-request transaction-scoped `client`).

In the `dispatchFactory`, after the existing tool wiring, construct the confirm collaborators bound to the request `client`:

```ts
import { getPolicy, liveSpendCents, proposeConfirmation, loadConfirmation, settleConfirmation, canonicalArgsHash } from './policies/repo.js';
import { evaluate } from './policies/engine.js';
import { toolMode, requiredApproverRoles } from './policies/schema.js';
import { createPricing, DRIFT_TOLERANCE } from './policies/pricing.js';
import { centsToEur } from './policies/money.js';
import { randomUUID } from 'node:crypto';
import { createListPendingConfirmationsTool } from './tools/list-pending-confirmations.js';
import { createConfirmPendingTool } from './tools/confirm-pending.js';

// inside dispatchFactory, after `tokenManager`:
const pricing = createPricing({ client: openproviderClient });
const CONFIRM_TTL_MS = 5 * 60 * 1000;

function tldsOf(toolName: string, args: unknown): string[] {
  if (toolName !== 'register_domain' && toolName !== 'update_domain') return [];
  const a = args as { domain?: { extension: string }; domains?: { extension: string }[] };
  if (a.domain) return [a.domain.extension];
  if (a.domains) return a.domains.map((d) => d.extension);
  return [];
}

const confirm: ConfirmDeps = {
  resolveMode: async (toolName) => {
    const policy = await getPolicy(client, principal.tenantId);
    return toolMode(policy, toolName);
  },
  propose: async ({ toolName, args, principal: p }) => {
    // serialize on the policy row
    await client.query('SELECT 1 FROM policies WHERE tenant_id = $1 FOR UPDATE', [p.tenantId]);
    const policy = await getPolicy(client, p.tenantId);
    const live = await liveSpendCents(client, p.tenantId);
    const token = await tokenManagerSafeToken(p.tenantId); // see note
    const estimatedCostCents = await pricing.price(toolName, args, token);
    const decision = evaluate({
      toolName, args, role: p.role ?? 'viewer', policy,
      liveSpendCents: live, estimatedCostCents, tldsInArgs: tldsOf(toolName, args),
    });
    if (decision.decision === 'deny') return { kind: 'denied', reason: decision.reason };
    if (decision.decision === 'allow') {
      // allow-mode shouldn't reach propose; treat as immediate (no confirmation)
      return { kind: 'denied', reason: 'not_confirm_mode' };
    }
    const approvers = requiredApproverRoles(policy, toolName);
    const rec = await proposeConfirmation({
      client, tenantId: p.tenantId, principalSubject: p.subject, toolName, args,
      summaryText: `${toolName} (est. €${centsToEur(estimatedCostCents)})`,
      estimatedCostCents, requiredApproverRoles: approvers, ttlMs: CONFIRM_TTL_MS,
    });
    return { kind: 'proposed', result: {
      confirmationId: rec.id, confirmationToken: rec.id, // token == id in Phase 4 (RLS-scoped; see note)
      summary: rec.summaryText, estimatedCostEur: centsToEur(rec.estimatedCostCents),
      requiredApproverRoles: rec.requiredApproverRoles, expiresAt: rec.expiresAt.toISOString(),
    } };
  },
  consume: async ({ token, toolName, args, principal: p }) => {
    const conf = await loadConfirmation(client, token);
    if (!conf) return { kind: 'error', code: 'confirmation_not_found' };
    if (conf.consumedAt) return { kind: 'error', code: 'confirmation_not_found' };
    if (conf.expiresAt.getTime() <= Date.now()) return { kind: 'error', code: 'confirmation_expired' };
    if (!canonicalArgsHash(args, p.tenantId).equals(conf.argsHash)) return { kind: 'error', code: 'validation_failed' };
    if (!conf.requiredApproverRoles.includes(p.role ?? '')) return { kind: 'error', code: 'approver_role_required' };
    // re-price + drift guard
    const token2 = await tokenManagerSafeToken(p.tenantId);
    const fresh = await pricing.price(toolName, args, token2);
    if (fresh > Math.round(conf.estimatedCostCents * (1 + DRIFT_TOLERANCE))) {
      await settleConfirmation(client, conf.id, 'released');
      return { kind: 'error', code: 'price_changed' };
    }
    return { kind: 'ok' }; // dispatcher then runs the handler; settle happens below
  },
};
```

> **Token == id note:** in Phase 4 the confirmation id IS the token. It's safe because confirmations are RLS-scoped to the tenant and single-use (the partial unique index + `consumed_at`), and `confirm_pending` takes `confirmation_id` directly. A separate opaque token adds nothing here; Phase 6 (dashboard, multi-user) can introduce one if cross-surface sharing needs it.

> **Settle-after-execute:** the dispatcher's consume path returns `ok`, then runs the handler. The handler's success/failure must drive `settleConfirmation(committed|released)`. Wire this by having the dispatcher call a `confirm.settle(confirmationId, outcome)` after handler execution, OR (simpler) have `consume` return the `confirmationId` and the dispatcher call `settle` in a finally. Add a `settle` method to `ConfirmDeps` and call it from the dispatcher: on handler success → `committed`, on throw → `released`. Update Task 7's dispatcher accordingly (small addition) and its tests.

> **`tokenManagerSafeToken`:** a thin wrapper that returns the Openprovider token but, for the synthetic test tool / non-billable tools, the pricing returns 0 without needing a real token — so wrap in try/catch returning '' when no Openprovider account is connected (pricing for cost-0 tools never calls upstream). For `register_domain` against an un-onboarded tenant, propose will surface `openprovider_not_connected` via pricing's checkDomain call — acceptable.

- [ ] **Step 2: Register the meta-tools** in the `tools` array (they need the request `client` / `confirm.consume`):

```ts
const tools = [
  createCheckDomainTool({ client: openproviderClient, tokenManager }),
  createListDomainsTool({ client: openproviderClient, tokenManager }),
  createGetDomainTool({ client: openproviderClient, tokenManager }),
  createListContactsTool({ client: openproviderClient, tokenManager }),
  createGetContactTool({ client: openproviderClient, tokenManager }),
  createListPendingConfirmationsTool({ getClient: () => client }),
  createConfirmPendingTool({ consume: async ({ confirmationId, args, principal: p }) => {
    const out = await confirm.consume({ token: confirmationId, toolName: '(via confirm_pending)', args, principal: p });
    if (out.kind === 'error') return out;
    return { kind: 'ok', result: { confirmed: confirmationId } };
  } }),
];

const dispatch = createDispatcher({ tools, audit: createPgAuditSink(client), confirm });
```

> `confirm_pending` needs the original tool's name to re-price; store `tool_name` on the confirmation (already in schema) and have `confirm.consume` load it from the row rather than taking it as a parameter. Adjust `consume` to read `conf.toolName` for the re-price step instead of the passed `toolName`. (Refine the signature so `confirm_pending` doesn't need to know the tool name.)

- [ ] **Step 3: Build + typecheck + lint**

Run: `npm run build && npm run typecheck && npm run lint`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/mcp/dispatch.ts src/mcp/dispatch.test.ts src/tools/confirm-pending.ts
git commit -m "feat(phase4): wire ConfirmDeps (propose/consume/settle) + meta-tools into server"
```

---

## Task 10: `policy:set` / `policy:show` CLI

**Files:**
- Create: `scripts/policy.ts`
- Modify: `package.json`

- [ ] **Step 1: Write `scripts/policy.ts`**

```ts
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { getPolicy, upsertPolicy } from '../src/policies/repo.js';
import { PolicyDoc } from '../src/policies/schema.js';

async function main(): Promise<void> {
  const sub = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { tenant: { type: 'string' }, file: { type: 'string' } },
  });
  if ((sub !== 'show' && sub !== 'set') || !values.tenant) {
    console.error('Usage: policy show --tenant <uuid> | policy set --tenant <uuid> --file <policy.json>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', values.tenant]);
    if (sub === 'show') {
      const doc = await getPolicy(client, values.tenant);
      console.error(JSON.stringify(doc, null, 2));
    } else {
      if (!values.file) { console.error('--file required for set'); process.exit(1); }
      const doc = PolicyDoc.parse(JSON.parse(readFileSync(values.file, 'utf8')));
      await upsertPolicy(client, values.tenant, doc);
      console.error(`Policy updated for tenant ${values.tenant}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add npm scripts to `package.json`**

```json
"policy:show": "tsx scripts/policy.ts show",
"policy:set": "tsx scripts/policy.ts set"
```

- [ ] **Step 3: Smoke (no-args usage guard)**

Run: `npx tsx scripts/policy.ts 2>&1 | head -2`
Expected: prints the usage line, exits non-zero (the guard runs before `loadConfig()`).

- [ ] **Step 4: typecheck + lint**

Run: `npm run typecheck && npm run lint`

- [ ] **Step 5: Commit**

```bash
git add scripts/policy.ts package.json
git commit -m "feat(phase4): policy:show / policy:set CLI with zod validation"
```

---

## Task 11: E2E — synthetic confirm tool through propose → confirm_pending → committed

**Files:**
- Modify: `tests/integration/mcp/e2e.test.ts`

- [ ] **Step 1: Add a Phase-4 scenario** to the e2e suite. Because the production `server.ts` registers only the real tools, the e2e constructs its own server wiring with an extra **synthetic confirm-mode tool** (`phase4.spend`) registered in the test's tool list, priced via an injected fixed pricer (€15), policy mode `confirm`. The test:
  1. Provision a tenant (auto via a real-shaped token), raise its cap to €100 via `upsertPolicy`.
  2. Call `phase4.spend` with no token → expect `confirmation_required` with a `confirmation_id`.
  3. Call `confirm_pending` with that id (as the owner) → expect success; the reservation is `committed`; `liveSpendCents` = 1500.
  4. Propose 7 times → the 7th is `policy_denied` (7×15=105 > 100).
  5. A second tenant at default `limit_eur:0` → `phase4.spend` propose → `policy_denied`.

> Implement the synthetic tool inline in the test file: `{ name:'phase4.spend', inputSchema: z.object({ note: z.string().default('x') }), handler: () => Promise.resolve({ spent: true }) }`, registered in the test server's `tools` list, with the policy's `tools` map including `'phase4.spend':'confirm'` and the injected pricer returning 1500 cents for it.

- [ ] **Step 2: Run, expect PASS**

Run: `npm run test:integration -- mcp/e2e`
Expected: all prior scenarios + the new Phase-4 scenario pass.

- [ ] **Step 3: Full integration sweep**

Run: `npm run test:integration`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/mcp/e2e.test.ts
git commit -m "test(phase4): e2e — confirm flow propose -> confirm_pending -> committed; cap denial"
```

---

## Task 12: README + CHANGELOG + `v0.5.0-phase4` tag (local only)

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `README.md`** — status → Phase 4; add `list_pending_confirmations` + `confirm_pending` to the tools table; document `policy:show`/`policy:set`; add a "Spend controls & confirmations" note (default cap €0 blocks billable writes; raise via `policy:set`).

- [ ] **Step 2: Prepend `## [0.5.0-phase4] — 2026-05-26` to `CHANGELOG.md`**

```markdown
## [0.5.0-phase4] — 2026-05-26

### Added
- Policy engine (`policies/engine`): per-tenant allow/deny/confirm with TLD allow+deny, role gate, and spend-cap evaluation.
- Content-bound confirmation flow: propose mints a confirmation + pending spend reservation; consume verifies hash/expiry/approver-role, re-prices with a 5% drift guard, then executes.
- Spend reservations with a lazy, worker-free accounting model: live spend computed from reservations (expired pending holds drop out via expires_at); SELECT … FOR UPDATE on the policy row serializes concurrent proposals (no overshoot — proven by a concurrency test).
- `list_pending_confirmations` + `confirm_pending` meta-tools (approver handoff).
- Default-on-provision policy (spend cap €0 = billable writes blocked until raised) seeded in resolve_or_provision_tenant; `policy:show` / `policy:set` CLI.
- Pricing module: cents-based, 24h TLD cache, premium-domain bypass, EUR-only.
- Migration 0008: policies, confirmations, spend_reservations (all RLS-scoped).

### Changed
- Dispatcher gained a confirm-mode branch (propose returns a confirmation token; consume executes the handler and settles the reservation).
- All money math is integer cents internally.

### Deferred
- Real write tools (register_domain etc.) + idempotency records — Phase 5.
- pg-boss workers (sweep / window rollup) — Phase 7/8.
- day/week spend windows; dashboard policy editor — Phase 6.
```

- [ ] **Step 3: Commit + tag (DO NOT PUSH)**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(phase4): CHANGELOG + README for 0.5.0-phase4"
git tag -a v0.5.0-phase4 -m "Phase 4: policy engine + confirmations + spend reservations"
```

- [ ] **Step 4: Verify**

Run: `git tag --list 'v0.*'`
Expected: `v0.2.0-phase1`, `v0.2.0-phase2`, `v0.4.0-phase3`, `v0.5.0-phase4`. **DO NOT PUSH.**

---

## Phase 4 exit checklist

- [ ] `policies/engine` unit + property tests green; cap math monotonic.
- [ ] Marquee concurrency test: 10 proposals @ €15 vs €100 cap → exactly 6 succeed, live spend never exceeds cap.
- [ ] propose → confirm_pending → committed works e2e; expiry, double-consume, wrong-approver, price-drift all rejected with the right codes.
- [ ] Default policy seeded on provision (limit €0 blocks billable writes); `policy:set` raises it.
- [ ] Pricing: cents, 24h cache, premium bypass, EUR-only.
- [ ] `npm test` + `npm run test:integration` green; typecheck + lint clean.
- [ ] CHANGELOG `0.5.0-phase4` + tag created locally.

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 schema (3 tables, cents handling) | 1 (money), 5 (migration), 6 (repo parsing) |
| §3 policy doc + default + approver helper | 2, 5 (seed) |
| §4 policies/engine | 3 |
| §5 lazy atomic spend accounting + marquee | 6 |
| §6 pricing + drift | 4 |
| §7 dispatcher confirm-mode | 7, 9 |
| §8 meta-tools | 8, 9 |
| §9 default-on-provision + CLI | 5 (seed), 10 (CLI), 6 (lazy getPolicy) |
| §10 tests | 1–8, 11 |

**Placeholder scan:** No "TBD". Task 9 contains the most prose (the server wiring crossroads) with two explicit refinement notes (token==id rationale; settle-after-execute requiring a small `confirm.settle` addition to the dispatcher) — these are design clarifications, not gaps, and each states the concrete resolution. Task 8/11 reference "mirror the setup" but include the actual test code for the locking assertions.

**Type consistency:** `Decision` (Task 3) consumed in Task 9. `PolicyDoc`/`DEFAULT_POLICY`/`toolMode`/`requiredApproverRoles` (Task 2) used in 3, 5, 6, 9. `ConfirmDeps`/`ProposeResult` (Task 7) implemented in Task 9. `proposeConfirmation`/`loadConfirmation`/`settleConfirmation`/`canonicalArgsHash`/`liveSpendCents` (Task 6) called in 8, 9, 11. Money helpers (Task 1) used in 4, 6, 9. The migration's default-policy JSON (Task 5) must equal `DEFAULT_POLICY` (Task 2) — flagged inline as a consistency requirement, and the lazy `getPolicy` (Task 6) converges any drift.

**One refinement folded into Task 9 during review:** `consume` must read the confirmation's stored `tool_name` for re-pricing (so `confirm_pending` needn't pass it), and a `settle` step must run after handler execution. Both are called out as explicit sub-steps in Task 9 so the implementer wires them rather than discovering them.

*End of Phase 4 plan.*

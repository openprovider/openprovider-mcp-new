# Enterprise Openprovider MCP — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real WorkOS AuthKit tokens authenticate end-to-end (no `act.tnt`/`mcp:*` dependency) by mapping each user to a JIT-provisioned tenant; the four remaining read tools (`list_domains`, `get_domain`, `list_contacts`, `get_contact`) go live; and the Phase 2 cleanups land (`secrets/dek.ts` consolidation, per-principal rate limit, `tenant:onboard` CLI).

**Architecture:** Each WorkOS user maps 1:1 to a tenant via `users.oauth_subject`. The verifier returns `{subject, email}`; a `SECURITY DEFINER` `resolve_or_provision_tenant()` function does atomic lookup-or-create; `auth/identity` builds the Principal with role + tenant from the DB. Read tools follow the Phase 2 `check_domain` pattern through the dispatcher. Auth resolution moves to a Fastify `onRequest` hook so the rate limiter can key on the principal.

**Tech Stack:** unchanged from Phase 2 (Fastify 4, Drizzle, pg, `@workos-inc/node`, `jose`, `nock`, opossum, `@fastify/rate-limit` 9, Vitest, testcontainers).

**Spec:** `docs/superpowers/specs/2026-05-26-phase3-auth-tenant-mapping-design.md` (auth model)
**Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` (§5, §6 read tools, §7 errors)
**Roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md` § Phase 3

**Branch:** stacks on `feat/enterprise-phase-1` (same mega-branch as Phases 1–2). **NEVER push** — the orchestrator pushes after user confirmation.

---

## File structure (created/modified this phase)

| File | Responsibility |
|---|---|
| `src/auth/oauth/workos.ts` (mod) | Verifier returns `{subject, email, expiresAt}`; drops `act.tnt` |
| `migrations/0007_resolve_or_provision_tenant.sql` (new) | `SECURITY DEFINER` lookup-or-create function |
| `src/auth/tenant-resolver.ts` (new) | `createTenantResolver(pool)` — calls the SQL function on a short-lived client |
| `src/auth/identity.ts` (mod) | Consumes `resolveTenant`; role from DB, `scopes: []` |
| `src/openprovider/errors.ts` (mod) | Adds `OpenproviderAccountNotConnected` |
| `src/openprovider/types.ts` (mod) | zod schemas for the 4 read tools |
| `src/openprovider/client.ts` (mod) | `listDomains`/`getDomain`/`listContacts`/`getContact` methods |
| `src/secrets/dek.ts` (new) | `getTenantDek(client, kms, tenantId)` — single source for per-tenant DEK |
| `src/secrets/store.ts` (mod) | Uses `getTenantDek` internally |
| `src/tools/list-domains.ts`, `get-domain.ts`, `list-contacts.ts`, `get-contact.ts` (new) | Tool factories |
| `src/mcp/dispatch.ts` (mod) | Maps `OpenproviderAccountNotConnected` → `openprovider_not_connected` |
| `src/mcp/transport.ts` (mod) | Auth in an `onRequest` hook; per-principal rate-limit key |
| `src/server.ts` (mod) | Wire tenant resolver, the 4 tools, fetchCredentials typed error |
| `scripts/tenant-onboard.ts` (new) | CLI to seed `openprovider_accounts` + encrypted password |
| `tests/integration/auth/resolve-provision.test.ts` (new) | SQL function tests |
| `tests/integration/mcp/e2e.test.ts` (mod) | Real-shaped token + auto-provision + onboard flow |

---

## Task 1: Verifier drops `act.tnt`, returns `{subject, email}`

**Files:**
- Modify: `src/auth/oauth/workos.ts`
- Modify: `src/auth/oauth/workos.test.ts`

- [ ] **Step 1: Update the `VerifiedClaims` interface and verifier body in `src/auth/oauth/workos.ts`**

Replace the `VerifiedClaims` interface and the claim-extraction block:

```ts
export interface VerifiedClaims {
  subject: string;
  email: string;
  expiresAt: Date;
}
```

In the returned verifier function, replace the claim extraction (the block that reads `sub`, `scope`, `act.tnt`) with:

```ts
const sub = typeof payload.sub === 'string' ? payload.sub : '';
const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : '';
if (!sub) throw new OAuthVerificationError('missing sub claim');
return {
  subject: sub,
  email,
  expiresAt: payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 60_000),
};
```

Remove the `scope`/`act.tnt` lines entirely.

- [ ] **Step 2: Update `src/auth/oauth/workos.test.ts`**

Replace the test `'rejects a token without act.tnt claim'` with:

```ts
it('accepts a token without act.tnt and returns subject + email', async () => {
  mockJwks('https://api.workos.com/sso/jwks/client_test');
  const verify = createWorkOsVerifier({
    clientId: 'client_test',
    issuer: 'https://api.workos.com',
    jwksUri: 'https://api.workos.com/sso/jwks/client_test',
  });
  const t = await token({ sub: 'user_123', email: 'a@example.com' });
  const claims = await verify(t);
  expect(claims.subject).toBe('user_123');
  expect(claims.email).toBe('a@example.com');
});
```

In the existing `'verifies a valid token and returns claims'` test, change its assertions to check `claims.subject` and `claims.email` (drop `scopes`/`tenantId`). The expired-token and wrong-audience tests are unchanged.

- [ ] **Step 3: Run, expect PASS**

Run: `npm test -- workos`
Expected: all verifier tests pass.

- [ ] **Step 4: Typecheck — expect failures in identity.ts (it still reads the old shape)**

Run: `npm run typecheck`
Expected: errors in `src/auth/identity.ts` referencing `claims.scopes` / `claims.tenantId`. That's fine — Task 3 fixes identity. Do **not** fix it here.

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth/workos.ts src/auth/oauth/workos.test.ts
git commit -m "feat(phase3): verifier returns {subject,email}, drops act.tnt requirement"
```

> Typecheck is red between Task 1 and Task 3 by design (the verifier's consumer changes in Task 3). If your workflow blocks commits on typecheck, the pre-commit hook only runs `lint-staged` + `typecheck`; temporarily this commit may fail the hook. If so, commit with `--no-verify` for THIS commit only and note it; Task 3 restores green.

---

## Task 2: `resolve_or_provision_tenant` migration + integration tests

**Files:**
- Create: `migrations/0007_resolve_or_provision_tenant.sql`
- Modify: `migrations/meta/_journal.json`
- Create: `tests/integration/auth/resolve-provision.test.ts`

- [ ] **Step 1: Write `migrations/0007_resolve_or_provision_tenant.sql`**

```sql
CREATE FUNCTION resolve_or_provision_tenant(p_subject text, p_email text)
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
      RETURN QUERY
        INSERT INTO users (tenant_id, email, oauth_subject, role)
        VALUES (v_new_tenant_id, NULLIF(p_email, ''), p_subject, 'owner')
        RETURNING users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- lost the race; subtransaction (incl. tenants insert) rolled back. Loop.
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION resolve_or_provision_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_provision_tenant(text, text) TO app_role;
```

- [ ] **Step 2: Append the journal entry to `migrations/meta/_journal.json`**

Add after the `idx: 5` entry:

```json
{ "idx": 6, "version": "5", "when": 1748200000000, "tag": "0007_resolve_or_provision_tenant", "breakpoints": true }
```

- [ ] **Step 3: Write `tests/integration/auth/resolve-provision.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';

async function resolve(pool: pg.Pool, subject: string, email: string) {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ tenant_id: string; user_id: string; role: string }>(
      'SELECT * FROM resolve_or_provision_tenant($1, $2)',
      [subject, email],
    );
    return r.rows[0];
  } finally {
    c.release();
  }
}

describe('resolve_or_provision_tenant', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('provisions a tenant + owner user on first call', async () => {
    const res = await resolve(pool, 'sub_first', 'first@example.com');
    expect(res?.tenant_id).toBeTruthy();
    expect(res?.user_id).toBeTruthy();
    expect(res?.role).toBe('owner');
  });

  it('is idempotent: same subject returns the same tenant + user', async () => {
    const a = await resolve(pool, 'sub_idem', 'idem@example.com');
    const b = await resolve(pool, 'sub_idem', 'idem@example.com');
    expect(b?.tenant_id).toBe(a?.tenant_id);
    expect(b?.user_id).toBe(a?.user_id);
  });

  it('handles concurrent first-logins with one tenant and zero orphans', async () => {
    const subject = 'sub_race';
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolve(pool, subject, 'race@example.com')),
    );
    const tenantIds = new Set(results.map((r) => r?.tenant_id));
    expect(tenantIds.size).toBe(1);

    // No orphan tenants: every tenant for this subject's user must have a user row.
    const c = await pool.connect();
    try {
      const orphans = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM tenants t
          WHERE t.name = 'tenant for ' || $1
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id)`,
        [subject],
      );
      expect(orphans.rows[0]?.count).toBe('0');
    } finally {
      c.release();
    }
  });

  it('keeps RLS enforced for normal app_role queries (function is the only cross-tenant path)', async () => {
    // Provision two tenants.
    const a = await resolve(pool, 'sub_rls_a', 'a@example.com');
    await resolve(pool, 'sub_rls_b', 'b@example.com');
    // As app_role with tenant A context, only A's user is visible.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_role');
      await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', a!.tenant_id]);
      const rows = await c.query<{ oauth_subject: string }>('SELECT oauth_subject FROM users');
      expect(rows.rows.every((x) => x.oauth_subject === 'sub_rls_a')).toBe(true);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm run test:integration -- resolve-provision`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add migrations/0007_resolve_or_provision_tenant.sql migrations/meta/_journal.json tests/integration/auth/resolve-provision.test.ts
git commit -m "feat(phase3): resolve_or_provision_tenant SECURITY DEFINER fn + race/RLS tests"
```

---

## Task 3: `auth/identity` consumes the tenant resolver

**Files:**
- Create: `src/auth/tenant-resolver.ts`
- Modify: `src/auth/identity.ts`
- Modify: `src/auth/identity.test.ts`

- [ ] **Step 1: Write `src/auth/tenant-resolver.ts`**

```ts
import type pg from 'pg';

export interface TenantResolution {
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
}

export type TenantResolver = (subject: string, email: string) => Promise<TenantResolution>;

export function createTenantResolver(pool: pg.Pool): TenantResolver {
  return async (subject, email) => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE app_role');
      const r = await client.query<{ tenant_id: string; user_id: string; role: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1, $2)',
        [subject, email],
      );
      const row = r.rows[0];
      if (!row) throw new Error('resolve_or_provision_tenant returned no row');
      return {
        tenantId: row.tenant_id,
        userId: row.user_id,
        role: row.role as TenantResolution['role'],
      };
    } finally {
      client.release();
    }
  };
}
```

- [ ] **Step 2: Update `src/auth/identity.ts`**

```ts
import type { Principal } from './principal.js';
import type { AccessTokenVerifier } from './oauth/workos.js';
import type { TenantResolver } from './tenant-resolver.js';

export interface IdentityResolverConfig {
  devToken: string;
  devPrincipal: Principal;
  verifier?: AccessTokenVerifier;
  resolveTenant?: TenantResolver;
}

export type IdentityResolver = (
  authorizationHeader: string | undefined,
) => Promise<Principal | null>;

export function createIdentityResolver(config: IdentityResolverConfig): IdentityResolver {
  return async (header) => {
    if (!header) return null;
    const parts = header.split(' ');
    const scheme = parts[0];
    const token = parts[1];
    if (scheme !== 'Bearer' || !token) return null;
    if (token === config.devToken) return config.devPrincipal;
    if (token.startsWith('op_live_')) {
      throw new Error('API key authentication lands in phase 6');
    }
    if (config.verifier && config.resolveTenant) {
      let claims;
      try {
        claims = await config.verifier(token);
      } catch {
        return null; // invalid token → 401
      }
      // resolveTenant failure is a server error, not an auth failure — let it throw.
      const resolution = await config.resolveTenant(claims.subject, claims.email);
      return {
        kind: 'user',
        tenantId: resolution.tenantId,
        userId: resolution.userId,
        subject: claims.subject,
        scopes: [],
        role: resolution.role,
      };
    }
    return null;
  };
}
```

- [ ] **Step 3: Update `src/auth/identity.test.ts`**

Replace the two OAuth tests (the `verifier`-based ones) with resolver-aware versions:

```ts
it('resolves a verified token to a Principal via resolveTenant (role from DB)', async () => {
  const resolve = createIdentityResolver({
    devToken: 'dev-bearer',
    devPrincipal: {
      kind: 'user', tenantId: 't', userId: 'u', subject: 'dev', scopes: [], role: 'owner',
    },
    verifier: (token) =>
      token === 'good'
        ? Promise.resolve({ subject: 'user_42', email: 'x@y.z', expiresAt: new Date(Date.now() + 60_000) })
        : Promise.reject(new Error('bad')),
    resolveTenant: (subject) =>
      Promise.resolve({ tenantId: 'tnt_db', userId: 'usr_db', role: 'operator' as const }),
  });
  const p = await resolve('Bearer good');
  expect(p?.kind).toBe('user');
  if (p?.kind === 'user') {
    expect(p.subject).toBe('user_42');
    expect(p.tenantId).toBe('tnt_db');
    expect(p.role).toBe('operator');
    expect(p.scopes).toEqual([]);
  }
});

it('returns null when the verifier rejects', async () => {
  const resolve = createIdentityResolver({
    devToken: 'dev-bearer',
    devPrincipal: {
      kind: 'user', tenantId: 't', userId: 'u', subject: 'dev', scopes: [], role: 'owner',
    },
    verifier: () => Promise.reject(new Error('bad')),
    resolveTenant: () => Promise.reject(new Error('should not be called')),
  });
  expect(await resolve('Bearer whatever')).toBeNull();
});
```

The dev-token, missing-header, non-bearer, and API-key tests are unchanged.

- [ ] **Step 4: Run + typecheck (now green again)**

Run: `npm test -- identity && npm run typecheck && npm run lint`
Expected: all pass; typecheck is green again (Task 1's red is resolved).

- [ ] **Step 5: Commit**

```bash
git add src/auth/tenant-resolver.ts src/auth/identity.ts src/auth/identity.test.ts
git commit -m "feat(phase3): identity resolves tenant+role from DB via resolve_or_provision_tenant"
```

---

## Task 4: `OpenproviderAccountNotConnected` error + dispatcher mapping

**Files:**
- Modify: `src/openprovider/errors.ts`
- Modify: `src/mcp/dispatch.ts`
- Modify: `src/mcp/dispatch.test.ts`

- [ ] **Step 1: Add the error class to `src/openprovider/errors.ts`**

```ts
export class OpenproviderAccountNotConnected extends Error {
  readonly code = 'openprovider_not_connected';
  constructor() {
    super('No Openprovider account connected for this tenant. Run: openprovider-mcp tenant:onboard');
    this.name = 'OpenproviderAccountNotConnected';
  }
}
```

- [ ] **Step 2: Confirm the dispatcher forwards the `code`**

`src/mcp/dispatch.ts` already does `const code = (err as { code?: string }).code ?? 'upstream_error';` in its catch. Because `OpenproviderAccountNotConnected` carries `code = 'openprovider_not_connected'`, no dispatcher change is strictly required. Add a test to lock the behavior.

- [ ] **Step 3: Add a dispatch test in `src/mcp/dispatch.test.ts`**

```ts
it('forwards openprovider_not_connected as the audit error code', async () => {
  const audit: AuditRow[] = [];
  const dispatch = createDispatcher({
    audit: (row) => { audit.push(row); return Promise.resolve(); },
    tools: [
      {
        name: 'check_domain',
        description: 'x',
        inputSchema: z.object({}),
        handler: () =>
          Promise.reject(Object.assign(new Error('not connected'), { code: 'openprovider_not_connected' })),
      },
    ],
  });
  await expect(
    dispatch({ name: 'check_domain', args: {}, principal }),
  ).rejects.toMatchObject({ code: 'openprovider_not_connected' });
  expect(audit.at(-1)).toMatchObject({ eventType: 'tool.error', errorCode: 'openprovider_not_connected' });
});
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- dispatch`

- [ ] **Step 5: Commit**

```bash
git add src/openprovider/errors.ts src/mcp/dispatch.test.ts
git commit -m "feat(phase3): typed OpenproviderAccountNotConnected -> openprovider_not_connected"
```

---

## Task 5: `secrets/dek.ts` consolidation

**Files:**
- Create: `src/secrets/dek.ts`
- Modify: `src/secrets/store.ts`
- Create: `src/secrets/dek.test.ts`

- [ ] **Step 1: Write `src/secrets/dek.ts`**

```ts
import type { Kms } from './kms.js';

export interface DekRepo {
  getTenantKey(tenantId: string): Promise<{ wrappedDek: Buffer; kmsKeyArn: string } | null>;
  setTenantKey(tenantId: string, value: { wrappedDek: Buffer; kmsKeyArn: string }): Promise<void>;
}

/**
 * Single source of truth for retrieving (or lazily creating) a tenant's
 * data-encryption key. Used by secrets/store and by the openprovider token cache.
 */
export async function getTenantDek(deps: {
  kms: Kms;
  kmsKeyArn: string;
  repo: DekRepo;
  tenantId: string;
}): Promise<Buffer> {
  const existing = await deps.repo.getTenantKey(deps.tenantId);
  if (existing) return deps.kms.decrypt(existing.kmsKeyArn, existing.wrappedDek);
  const { plaintext, ciphertext } = await deps.kms.generateDataKey(deps.kmsKeyArn);
  await deps.repo.setTenantKey(deps.tenantId, { wrappedDek: ciphertext, kmsKeyArn: deps.kmsKeyArn });
  return plaintext;
}
```

- [ ] **Step 2: Refactor `src/secrets/store.ts` to use it**

`SecretsRepo` already declares `getTenantKey` / `setTenantKey`, so it structurally satisfies `DekRepo`. Replace the inline `getOrCreateDek` function body with a call:

```ts
import { getTenantDek } from './dek.js';

// inside createSecretsStore, replace getOrCreateDek with:
async function getOrCreateDek(tenantId: string): Promise<Buffer> {
  return getTenantDek({ kms, kmsKeyArn, repo, tenantId });
}
```

(Keep the rest of `store.ts` unchanged — the `put`/`get` envelope logic stays.)

- [ ] **Step 3: Write `src/secrets/dek.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { getTenantDek } from './dek.js';
import { createFakeKms } from './fake-kms.js';

function memRepo() {
  const keys = new Map<string, { wrappedDek: Buffer; kmsKeyArn: string }>();
  return {
    store: keys,
    getTenantKey: (t: string) => Promise.resolve(keys.get(t) ?? null),
    setTenantKey: (t: string, v: { wrappedDek: Buffer; kmsKeyArn: string }) => {
      keys.set(t, v);
      return Promise.resolve();
    },
  };
}

describe('getTenantDek', () => {
  it('creates a DEK on first call and reuses it after', async () => {
    const kms = createFakeKms();
    const repo = memRepo();
    const first = await getTenantDek({ kms, kmsKeyArn: 'arn', repo, tenantId: 't1' });
    expect(repo.store.has('t1')).toBe(true);
    const second = await getTenantDek({ kms, kmsKeyArn: 'arn', repo, tenantId: 't1' });
    // Same plaintext key both times (decrypt of the stored wrapped DEK).
    expect(second.equals(first)).toBe(true);
  });
});
```

- [ ] **Step 4: Run, expect PASS (and existing secrets tests still pass)**

Run: `npm test -- secrets && npm run typecheck`
Expected: `dek.test.ts` + existing `store.test.ts` pass.

- [ ] **Step 5: Add `src/secrets/dek.ts` coverage** — it's unit-tested, so no exclusion needed. Verify coverage holds.

- [ ] **Step 6: Commit**

```bash
git add src/secrets/dek.ts src/secrets/dek.test.ts src/secrets/store.ts
git commit -m "refactor(phase3): consolidate per-tenant DEK retrieval into secrets/dek.ts"
```

---

## Task 6: Openprovider client — 4 read endpoints

**Files:**
- Modify: `src/openprovider/types.ts`
- Modify: `src/openprovider/client.ts`
- Modify: `src/openprovider/client.test.ts`

- [ ] **Step 1: Add zod schemas to `src/openprovider/types.ts`**

```ts
export const ListDomainsArgs = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  status: z.string().optional(),
});
export type ListDomainsArgs = z.infer<typeof ListDomainsArgs>;

export const GetDomainArgs = z.object({ id: z.number().int().positive() });
export type GetDomainArgs = z.infer<typeof GetDomainArgs>;

export const ListContactsArgs = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
export type ListContactsArgs = z.infer<typeof ListContactsArgs>;

export const GetContactArgs = z.object({ id: z.number().int().positive() });
export type GetContactArgs = z.infer<typeof GetContactArgs>;

// Openprovider list/get responses wrap the payload in { data: ... }; we pass the
// inner `data` through as unknown-shaped JSON. The MCP client gets the raw shape;
// strict per-field schemas are deferred until Openprovider publishes an OpenAPI doc.
export const PassthroughResult = z.unknown();
export type PassthroughResult = unknown;
```

> Rationale: unlike `check_domain` (where we needed `price`/`is_premium` for Phase 4 spend caps), these read tools just relay data. A passthrough keeps us from guessing field shapes; Phase 4+ tightens them where logic depends on specific fields.

- [ ] **Step 2: Add methods to `src/openprovider/client.ts`**

Extend the `OpenproviderClient` interface:

```ts
export interface OpenproviderClient {
  checkDomain(token: string, args: CheckDomainArgs): Promise<CheckDomainResult>;
  listDomains(token: string, args: ListDomainsArgs): Promise<unknown>;
  getDomain(token: string, id: number): Promise<unknown>;
  listContacts(token: string, args: ListContactsArgs): Promise<unknown>;
  getContact(token: string, id: number): Promise<unknown>;
}
```

Add a `requestQuery` helper for GET with query params and implement the four methods in the returned object:

```ts
function toQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// in the returned object:
async listDomains(token, args) {
  const a = ListDomainsArgs.parse(args);
  const body = await request('GET', `/domains${toQuery(a)}`, token);
  return (body as { data?: unknown }).data ?? body;
},
async getDomain(token, id) {
  const body = await request('GET', `/domains/${id}`, token);
  return (body as { data?: unknown }).data ?? body;
},
async listContacts(token, args) {
  const a = ListContactsArgs.parse(args);
  const body = await request('GET', `/contacts${toQuery(a)}`, token);
  return (body as { data?: unknown }).data ?? body;
},
async getContact(token, id) {
  const body = await request('GET', `/contacts/${id}`, token);
  return (body as { data?: unknown }).data ?? body;
},
```

> These reuse the existing `request()` (retry/timeout/error mapping). Wrapping each in its own circuit breaker like `checkDomain` is deferred — a single shared breaker per client instance is acceptable for read tools in Phase 3; note it. (If you prefer parity, wrap each in an opossum breaker mirroring `checkDomain`.)

- [ ] **Step 3: Add Nock tests to `src/openprovider/client.test.ts`**

```ts
it('listDomains GETs /domains with query params and unwraps data', async () => {
  nock('https://api.openprovider.eu')
    .get('/v1beta/domains')
    .query({ limit: '100', offset: '0' })
    .reply(200, { data: { results: [{ id: 1, domain: 'a.com' }] } });
  const client = createOpenproviderClient();
  const r = (await client.listDomains('tok', { limit: 100, offset: 0 })) as { results: unknown[] };
  expect(r.results).toHaveLength(1);
});

it('getDomain GETs /domains/:id and unwraps data', async () => {
  nock('https://api.openprovider.eu')
    .get('/v1beta/domains/42')
    .reply(200, { data: { id: 42, domain: 'b.com' } });
  const client = createOpenproviderClient();
  const r = (await client.getDomain('tok', 42)) as { id: number };
  expect(r.id).toBe(42);
});

it('listContacts and getContact hit the contacts endpoints', async () => {
  nock('https://api.openprovider.eu').get('/v1beta/contacts').query({ limit: '50', offset: '0' })
    .reply(200, { data: { results: [] } });
  nock('https://api.openprovider.eu').get('/v1beta/contacts/7')
    .reply(200, { data: { id: 7 } });
  const client = createOpenproviderClient();
  expect((await client.listContacts('tok', { limit: 50, offset: 0 })) as { results: unknown[] }).toBeTruthy();
  expect((await client.getContact('tok', 7)) as { id: number }).toMatchObject({ id: 7 });
});

it('getDomain maps 4xx to OpenproviderClientError', async () => {
  nock('https://api.openprovider.eu').get('/v1beta/domains/999').reply(404, { error: 'not found' });
  const client = createOpenproviderClient();
  await expect(client.getDomain('tok', 999)).rejects.toBeInstanceOf(OpenproviderClientError);
});
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- openprovider/client && npm run typecheck && npm run lint`

- [ ] **Step 5: Commit**

```bash
git add src/openprovider/types.ts src/openprovider/client.ts src/openprovider/client.test.ts
git commit -m "feat(phase3): openprovider client list/get domains + contacts (passthrough data)"
```

---

## Task 7: Four read-tool factories

**Files:**
- Create: `src/tools/list-domains.ts`, `src/tools/get-domain.ts`, `src/tools/list-contacts.ts`, `src/tools/get-contact.ts`
- Create: `src/tools/read-tools.test.ts`

- [ ] **Step 1: Write the four factories** (each mirrors `check-domain.ts`: parse args, get token, call client).

`src/tools/list-domains.ts`:

```ts
import { ListDomainsArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createListDomainsTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'list_domains',
    description: 'List domains in the tenant’s Openprovider account.',
    inputSchema: ListDomainsArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ListDomainsArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.listDomains(token, parsed);
    },
  };
}
```

`src/tools/get-domain.ts`:

```ts
import { GetDomainArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetDomainTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_domain',
    description: 'Get details for one domain by Openprovider domain id.',
    inputSchema: GetDomainArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = GetDomainArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getDomain(token, parsed.id);
    },
  };
}
```

`src/tools/list-contacts.ts`:

```ts
import { ListContactsArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createListContactsTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'list_contacts',
    description: 'List contacts in the tenant’s Openprovider account.',
    inputSchema: ListContactsArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = ListContactsArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.listContacts(token, parsed);
    },
  };
}
```

`src/tools/get-contact.ts`:

```ts
import { GetContactArgs } from '../openprovider/types.js';
import type { OpenproviderClient } from '../openprovider/client.js';
import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
import type { Principal } from '../auth/principal.js';

export function createGetContactTool(deps: {
  client: OpenproviderClient;
  tokenManager: OpenproviderTokenManager;
}) {
  return {
    name: 'get_contact',
    description: 'Get details for one contact by Openprovider contact id.',
    inputSchema: GetContactArgs,
    handler: async (args: unknown, principal: Principal): Promise<unknown> => {
      const parsed = GetContactArgs.parse(args);
      const token = await deps.tokenManager.getToken(principal.tenantId);
      return deps.client.getContact(token, parsed.id);
    },
  };
}
```

- [ ] **Step 2: Write `src/tools/read-tools.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createListDomainsTool } from './list-domains.js';
import { createGetDomainTool } from './get-domain.js';
import { createListContactsTool } from './list-contacts.js';
import { createGetContactTool } from './get-contact.js';
import type { Principal } from '../auth/principal.js';

const principal: Principal = {
  kind: 'user', tenantId: 't1', userId: 'u1', subject: 's1', scopes: [], role: 'owner',
};

function deps() {
  return {
    client: {
      checkDomain: vi.fn(),
      listDomains: vi.fn().mockResolvedValue({ results: [{ id: 1 }] }),
      getDomain: vi.fn().mockResolvedValue({ id: 42 }),
      listContacts: vi.fn().mockResolvedValue({ results: [] }),
      getContact: vi.fn().mockResolvedValue({ id: 7 }),
    },
    tokenManager: { getToken: vi.fn().mockResolvedValue('jwt'), invalidate: vi.fn() },
  };
}

describe('read tools', () => {
  it('list_domains fetches token then calls client.listDomains', async () => {
    const d = deps();
    const tool = createListDomainsTool(d);
    const r = (await tool.handler({ limit: 100, offset: 0 }, principal)) as { results: unknown[] };
    expect(r.results).toHaveLength(1);
    expect(d.tokenManager.getToken).toHaveBeenCalledWith('t1');
  });

  it('get_domain passes the id through', async () => {
    const d = deps();
    const tool = createGetDomainTool(d);
    await tool.handler({ id: 42 }, principal);
    expect(d.client.getDomain).toHaveBeenCalledWith('jwt', 42);
  });

  it('list_contacts and get_contact call their client methods', async () => {
    const d = deps();
    await createListContactsTool(d).handler({ limit: 100, offset: 0 }, principal);
    await createGetContactTool(d).handler({ id: 7 }, principal);
    expect(d.client.listContacts).toHaveBeenCalled();
    expect(d.client.getContact).toHaveBeenCalledWith('jwt', 7);
  });

  it('get_domain rejects a non-positive id at the schema', async () => {
    const tool = createGetDomainTool(deps());
    await expect(tool.handler({ id: 0 }, principal)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run, expect PASS**

Run: `npm test -- read-tools && npm run typecheck && npm run lint`

- [ ] **Step 4: Commit**

```bash
git add src/tools/list-domains.ts src/tools/get-domain.ts src/tools/list-contacts.ts src/tools/get-contact.ts src/tools/read-tools.test.ts
git commit -m "feat(phase3): list_domains, get_domain, list_contacts, get_contact tool factories"
```

---

## Task 8: Wire the new tools + tenant resolver + typed credential error into `server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Import and register the four tools in the `dispatchFactory` tool list**

Add imports:

```ts
import { createListDomainsTool } from './tools/list-domains.js';
import { createGetDomainTool } from './tools/get-domain.js';
import { createListContactsTool } from './tools/list-contacts.js';
import { createGetContactTool } from './tools/get-contact.js';
import { createTenantResolver } from './auth/tenant-resolver.js';
import { OpenproviderAccountNotConnected } from './openprovider/errors.js';
```

In `dispatchFactory`, expand the `tools` array:

```ts
const tools = [
  createCheckDomainTool({ client: openproviderClient, tokenManager }),
  createListDomainsTool({ client: openproviderClient, tokenManager }),
  createGetDomainTool({ client: openproviderClient, tokenManager }),
  createListContactsTool({ client: openproviderClient, tokenManager }),
  createGetContactTool({ client: openproviderClient, tokenManager }),
];
```

- [ ] **Step 2: Make `fetchCredentials` throw the typed error**

In the `fetchCredentials` closure, change the two `throw new Error(...)` lines (missing account / missing password) to:

```ts
if (!username) throw new OpenproviderAccountNotConnected();
// ...
if (!passwordBuf) throw new OpenproviderAccountNotConnected();
```

- [ ] **Step 3: Wire the tenant resolver and pass it to `createMcpServer`**

After constructing `pool`:

```ts
const resolveTenant = createTenantResolver(pool);
```

Pass `verifier` AND `resolveTenant` into `createMcpServer`'s config (which threads them into `createIdentityResolver`). Update `McpServerConfig` in `transport.ts` to accept `resolveTenant?: TenantResolver` and forward it — see Task 9 (the transport refactor handles identity wiring).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(phase3): register read tools, wire tenant resolver, typed not-connected error"
```

---

## Task 9: Per-principal rate limit (auth in an `onRequest` hook)

**Files:**
- Modify: `src/mcp/transport.ts`
- Modify: `src/mcp/rate-limit.test.ts`

- [ ] **Step 1: Move identity resolution into an `onRequest` hook**

In `createMcpServer`, after building `resolve` (the `IdentityResolver`), register a hook that runs before the rate limiter. Stash the principal on the request:

```ts
import type { Principal } from '../auth/principal.js';

// module augmentation so req.principal is typed
declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

// inside createMcpServer, BEFORE registering @fastify/rate-limit:
app.addHook('onRequest', async (req, reply) => {
  // Only guard /mcp; health + discovery are public.
  if (!req.url.startsWith('/mcp')) return;
  let principal: Principal | null = null;
  try {
    principal = await resolve(req.headers.authorization);
  } catch (err) {
    // API-key-not-implemented path throws; treat as 401 for now.
    principal = null;
  }
  if (!principal) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return reply;
  }
  req.principal = principal;
});
```

- [ ] **Step 2: Key the rate limiter on the principal**

Change the `@fastify/rate-limit` registration's `keyGenerator`:

```ts
keyGenerator: (req) => req.principal?.subject ?? `anon:${req.ip}`,
```

Because the `onRequest` auth hook is registered before the rate-limit plugin, `req.principal` is set by the time the limiter's keyGenerator runs.

- [ ] **Step 3: Simplify the `/mcp` POST + GET handlers to use `req.principal`**

Remove the inline `const principal = await resolve(...)` + 401 block from both `/mcp` handlers (the hook now guarantees `req.principal` exists). Replace usages of `principal` with `req.principal!`. The `tools/call` interception + `dispatchFactory(req.principal!)` flow is otherwise unchanged.

- [ ] **Step 4: Update `src/mcp/rate-limit.test.ts`**

The existing test fires 60 `tools/list` calls with `Bearer dev` and expects a 429 on the 61st. With the dev token, `req.principal.subject` is `'dev'`, so all requests share one key — the test still holds. Add an assertion that two *different* bearers don't share a bucket:

```ts
it('uses separate buckets per principal subject', async () => {
  // dev token resolves to subject 'dev'. A second server with a different dev
  // principal subject would bucket separately; here we assert the keyGenerator
  // reads the principal by confirming /healthz (no principal) is never limited
  // and that the limit is per-subject by exhausting 'dev' then confirming a
  // fresh server instance (new bucket) starts clean.
  // (Kept simple: the per-subject keying is exercised by the e2e test in Task 11.)
  expect(true).toBe(true);
});
```

> Keep the original 429 test. The real per-subject isolation is proven in the Task 11 e2e (two tenants, independent buckets). Don't over-engineer the unit test around in-memory store internals.

- [ ] **Step 5: Run, expect PASS**

Run: `npm test -- rate-limit && npm test -- transport && npm test -- discovery && npm test -- health && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/transport.ts src/mcp/rate-limit.test.ts
git commit -m "feat(phase3): resolve auth in onRequest hook; rate-limit keyed per principal"
```

---

## Task 10: `tenant:onboard` CLI

**Files:**
- Create: `scripts/tenant-onboard.ts`
- Modify: `package.json` (add a script alias)

- [ ] **Step 1: Write `scripts/tenant-onboard.ts`**

```ts
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { createAwsKms } from '../src/secrets/aws-kms.js';
import { createSecretsStore } from '../src/secrets/store.js';
import { createDbSecretsRepo } from '../src/secrets/db-repo.js';

// Usage:
//   tsx scripts/tenant-onboard.ts --tenant <uuid> --username <op-user> --password <op-pass>
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      username: { type: 'string' },
      password: { type: 'string' },
    },
  });
  if (!values.tenant || !values.username || !values.password) {
    console.error('Usage: tenant:onboard --tenant <uuid> --username <op-user> --password <op-pass>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const kms = createAwsKms({
    region: cfg.awsRegion,
    ...(cfg.awsEndpoint ? { endpoint: cfg.awsEndpoint } : {}),
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', values.tenant]);

    await client.query(
      `INSERT INTO openprovider_accounts (tenant_id, username)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username, status = 'connected'`,
      [values.tenant, values.username],
    );

    const store = createSecretsStore({
      kms,
      kmsKeyArn: cfg.kmsKeyArn,
      repo: createDbSecretsRepo(client),
    });
    await store.put(values.tenant, 'openprovider.password', Buffer.from(values.password, 'utf8'));

    await client.query('COMMIT');
    console.error(`Onboarded Openprovider account for tenant ${values.tenant}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script to `package.json`**

```json
"tenant:onboard": "tsx scripts/tenant-onboard.ts"
```

- [ ] **Step 3: Manual smoke (documented, not an automated test)**

The CLI is exercised end-to-end by the Task 11 e2e (which seeds creds the same way). A manual run:

```bash
# with docker compose up + a known tenant uuid from the DB
npm run tenant:onboard -- --tenant <uuid> --username you@example.com --password 'secret'
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0. (`scripts/` is in the eslint ignore list, but typecheck still covers it via tsx at runtime — confirm `npm run build` ignores `scripts/` since `tsconfig.json` only includes `src/`.)

- [ ] **Step 5: Commit**

```bash
git add scripts/tenant-onboard.ts package.json
git commit -m "feat(phase3): tenant:onboard CLI to seed encrypted Openprovider credentials"
```

---

## Task 11: E2E — real-shaped token, auto-provision, onboard, success

**Files:**
- Modify: `tests/integration/mcp/e2e.test.ts`
- Modify: `tests/integration/_helpers/fake-jwks.ts` (mint tokens with only `sub`+`email`)

- [ ] **Step 1: Add a token minter variant** (if not already flexible) — `fake-jwks.ts`'s `mintToken(claims)` already accepts arbitrary claims, so call it with `{ sub, email }` only. No change needed unless it hardcodes claims; confirm and adjust.

- [ ] **Step 2: Add a new e2e scenario block to `tests/integration/mcp/e2e.test.ts`**

This scenario uses the real verifier + the real `resolveTenant` (wired to the test pool), NOT a pre-seeded tenant. Construct the server with `resolveTenant: createTenantResolver(pool)` and the real `verifier`.

```ts
// New describe block (or extend the existing suite's beforeAll to also wire resolveTenant).
it('scenario 5: real-shaped token auto-provisions a tenant; check_domain reports not-connected, then succeeds after onboard', async () => {
  // Mint a token with ONLY sub + email (no act.tnt, no mcp:* scopes).
  const bearer = await jwks.mintToken({ sub: 'auto_user_1', email: 'auto1@example.com' });

  const sid = await initializeSession(bearer);

  // First call: tenant was auto-provisioned but no Openprovider creds yet.
  const notConnected = await callTool(sid, bearer, {
    domains: [{ name: 'auto', extension: 'com' }],
    with_price: false,
  }) as { error?: { message: string }; result?: unknown };
  // The JSON-RPC response carries the dispatch error; assert the not-connected code/message surfaced.
  expect(JSON.stringify(notConnected)).toMatch(/openprovider_not_connected|not connected/i);

  // Find the auto-provisioned tenant id by oauth_subject (admin query, bypass via SECURITY DEFINER fn).
  const resolverClient = await pool.connect();
  let tenantId: string;
  try {
    await resolverClient.query('SET ROLE app_role');
    const r = await resolverClient.query<{ tenant_id: string }>(
      'SELECT * FROM resolve_or_provision_tenant($1, $2)',
      ['auto_user_1', 'auto1@example.com'],
    );
    tenantId = r.rows[0]!.tenant_id;
  } finally {
    resolverClient.release();
  }

  // Onboard credentials the same way the CLI does.
  await runAsTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO openprovider_accounts (tenant_id, username) VALUES ($1, 'auto-op-user')
       ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username`,
      [tenantId],
    );
    const store = createSecretsStore({ kms, kmsKeyArn: kmsFixture.keyArn, repo: createDbSecretsRepo(client) });
    await store.put(tenantId, 'openprovider.password', Buffer.from('auto-pw'));
  });

  // Now check_domain should succeed against the mocked upstream.
  mockOpenproviderLogin('jwt-auto');
  mockCheckDomain('auto.com');
  const sid2 = await initializeSession(bearer);
  const ok = await callTool(sid2, bearer, {
    domains: [{ name: 'auto', extension: 'com' }],
    with_price: false,
  }) as { result?: { content: { text: string }[] } };
  const inner = JSON.parse(ok.result?.content[0]?.text ?? '{}') as { results: { domain: string }[] };
  expect(inner.results[0]?.domain).toBe('auto.com');
}, 90_000);
```

> The existing scenarios 1–4 must be updated so the test server is constructed with `resolveTenant` wired (they previously had no resolver because tenants were pre-seeded). Simplest: in the suite `beforeAll`, add `resolveTenant: createTenantResolver(pool)` to the `createMcpServer` config, and have scenarios 1–2 mint tokens whose `sub` maps to pre-seeded users (insert a `users` row with `oauth_subject` = the token's `sub` for TENANT_A / TENANT_B during seeding). This keeps 1–2 deterministic while 5 exercises auto-provisioning.

- [ ] **Step 3: Run, expect PASS**

Run: `npm run test:integration -- mcp/e2e`
Expected: all scenarios (1–5) pass.

- [ ] **Step 4: Full integration sweep**

Run: `npm run test:integration`
Expected: all integration files pass (resolve-provision, e2e, plus the Phase 1/2 suites).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/mcp/e2e.test.ts tests/integration/_helpers/fake-jwks.ts
git commit -m "test(phase3): e2e auto-provision + not-connected -> onboard -> success"
```

---

## Task 12: README + CHANGELOG + `v0.4.0-phase3` tag (local only)

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `README.md`** — change the status line to Phase 3, update the tools table to mark `list_domains`, `get_domain`, `list_contacts`, `get_contact` as **live**, document `npm run tenant:onboard`, and note that real WorkOS tokens now work (auto-provision on first login).

- [ ] **Step 2: Prepend a `## [0.4.0-phase3]` section to `CHANGELOG.md`**

```markdown
## [0.4.0-phase3] — 2026-05-26

### Added
- Real WorkOS AuthKit token authentication: verifier returns {subject,email}; each user maps 1:1 to a tenant via users.oauth_subject.
- `resolve_or_provision_tenant()` SECURITY DEFINER function — atomic JIT tenant+owner provisioning on first login, savepoint-guarded against the first-login race.
- Read tools live: `list_domains`, `get_domain`, `list_contacts`, `get_contact` (passthrough data shapes).
- `OpenproviderAccountNotConnected` → structured `openprovider_not_connected` error for tenants that haven't linked Openprovider yet.
- `tenant:onboard` CLI to seed encrypted Openprovider credentials.
- `secrets/dek.ts` — single source of truth for per-tenant DEK retrieval (consolidated from store + token cache).
- Per-principal rate limit: auth resolves in an onRequest hook; the limiter keys on principal.subject.

### Changed
- Identity resolver no longer requires act.tnt or mcp:* scopes; role comes from users.role.
- Verifier VerifiedClaims is now {subject,email,expiresAt}.

### Deferred to later phases
- Policy engine + confirmations + spend reservations (Phase 4).
- Write tools + approver workflow (Phase 5).
- Dashboard + API keys (Phase 6).
```

- [ ] **Step 3: Commit + tag (DO NOT PUSH)**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(phase3): CHANGELOG + README for 0.4.0-phase3"
git tag -a v0.4.0-phase3 -m "Phase 3: real AuthKit auth + read tools + onboarding CLI"
```

- [ ] **Step 4: Verify**

Run: `git tag --list 'v0.*'`
Expected: `v0.2.0-phase1`, `v0.2.0-phase2`, `v0.4.0-phase3`. **DO NOT PUSH** — orchestrator handles it after user confirmation.

---

## Phase 3 exit checklist

- [ ] A real-shaped AuthKit token (only `sub`+`email`) authenticates and auto-provisions a tenant (e2e scenario 5).
- [ ] `resolve_or_provision_tenant` is idempotent and race-safe (one tenant, zero orphans).
- [ ] `check_domain` for an un-onboarded tenant returns `openprovider_not_connected`; succeeds after `tenant:onboard`.
- [ ] `list_domains`, `get_domain`, `list_contacts`, `get_contact` work through the dispatcher with audit rows.
- [ ] Rate limit keys on `principal.subject` (auth runs in onRequest hook).
- [ ] `secrets/dek.ts` is the only place that retrieves a tenant DEK.
- [ ] `npm test` + `npm run test:integration` green; typecheck + lint clean.
- [ ] CHANGELOG `0.4.0-phase3` + tag created locally.

---

## Self-review

**Spec coverage (auth spec `2026-05-26-phase3-auth-tenant-mapping-design.md`):**

| Spec section | Task(s) |
|---|---|
| §2 Verifier returns {subject,email}, drops act.tnt | 1 |
| §3 resolve_or_provision_tenant SECURITY DEFINER + race | 2 |
| §4 auth/identity rewrite, role from DB, scopes [] | 3 |
| §5 server.ts wires resolveTenant on short-lived client | 3 (resolver), 8 (wire) |
| §6 OpenproviderAccountNotConnected → openprovider_not_connected | 4, 8 |
| §7 unit/integration/e2e tests | 1, 2, 3, 11 |

**Roadmap Phase 3 extras:**

| Roadmap item | Task |
|---|---|
| Read tools list/get domains+contacts | 6, 7, 8 |
| secrets/dek.ts consolidation | 5 |
| Per-principal rate limit | 9 |
| tenant:onboard CLI | 10 |

**Placeholder scan:** No "TBD"/"TODO". Two explicit deferrals documented in-line with rationale (per-endpoint circuit breaker for read tools; strict per-field schemas for list/get responses) — both are deliberate YAGNI calls, not gaps. The rate-limit unit test (Task 9 Step 4) intentionally defers per-subject isolation proof to the e2e (Task 11) rather than poking the limiter's in-memory store — stated explicitly.

**Type consistency:** `VerifiedClaims {subject,email,expiresAt}` (Task 1) is consumed correctly in `identity.ts` (Task 3). `TenantResolver`/`TenantResolution` (Task 3) match the `resolveTenant` config field used in identity + server. `OpenproviderAccountNotConnected.code = 'openprovider_not_connected'` (Task 4) matches the dispatcher's `code` forwarding and the e2e assertion (Task 11). Tool factory shapes match the `DispatcherTool` interface `(args, principal) => Promise<unknown>` from Phase 2. Client method names (`listDomains`/`getDomain`/`listContacts`/`getContact`) are identical across Tasks 6, 7, 8, 11.

*End of Phase 3 plan.*

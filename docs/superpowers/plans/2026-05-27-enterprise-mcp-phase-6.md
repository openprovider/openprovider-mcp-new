# Enterprise Openprovider MCP — Phase 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the `op_live_` API-key auth path (argon2id, `api_keys` table, cross-tenant `resolve_api_key`) and ship a single-owner server-rendered dashboard (Fastify + eta + htmx, WorkOS hosted login) for credential onboarding, policy editing, API-key management, audit viewing, and confirmation approval.

**Architecture:** API keys mirror the Phase-3 cross-tenant pattern (SECURITY DEFINER lookup + argon2 verify) and produce a `service` Principal. The dashboard mounts on the existing Fastify app under `/dashboard` with a signed cookie session (WorkOS hosted login → Phase-3 user→tenant resolver), each route using the same RLS-scoped per-request connection as `/mcp`. A shared `onboard-credentials` helper backs both the CLI and the dashboard form.

**Tech Stack additions:** `argon2`, `@fastify/view`, `eta`, `@fastify/cookie`, `@fastify/formbody`, `@fastify/static`, `htmx` (vendored static asset).

**Spec:** `docs/superpowers/specs/2026-05-26-phase6-dashboard-design.md`
**Branch:** stacks on `feat/enterprise-phase-1`. **NEVER push** — orchestrator pushes after user confirmation.

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/0011_api_keys.sql` (new) | api_keys table + resolve_api_key SECURITY DEFINER |
| `src/db/schema.ts` (mod) | apiKeys mirror |
| `src/auth/api-key.ts` (new) | key format, argon2 hash/verify, `issueApiKey`, `createApiKeyResolver` |
| `src/auth/identity.ts` (mod) | op_live_ branch → resolver |
| `src/tenants/onboard-credentials.ts` (new) | shared encrypt+upsert helper |
| `scripts/tenant-onboard.ts` (mod) | use shared helper |
| `src/dashboard/session.ts` (new) | cookie session + requireSession + CSRF |
| `src/dashboard/server.ts` (new) | register view/cookie/static + mount routes |
| `src/dashboard/routes/*.ts` (new) | page handlers |
| `src/dashboard/views/*.eta` (new) | layout + pages |
| `src/server.ts` (mod) | wire apiKeyResolver + service effective-role + mount dashboard |
| `package.json` (mod) | + argon2, @fastify/view, eta, @fastify/cookie, @fastify/formbody, @fastify/static |

**Task order:** API-key core (1–4) lands first (backend, unblocks the dashboard keys page); then the shared helper (5); then dashboard scaffold/session (6); then pages (7–8); e2e (9); docs/tag (10).

---

# PART 1 — API-Key Authentication (Tasks 1–4)

## Task 1: API-key helpers — format, hash, verify, issue

**Files:**
- Create: `src/auth/api-key.ts`
- Create: `src/auth/api-key.test.ts`

- [ ] **Step 1: Install argon2; verify Docker still builds**

```bash
npm install argon2
docker build -t openprovider-mcp:phase6-argon2check . >/tmp/argon2build.log 2>&1 && echo "docker build OK" || (echo "docker build FAILED — see log"; tail -20 /tmp/argon2build.log)
```
If the build fails on argon2's native step, add to the build stage of `Dockerfile` BEFORE `npm ci`:
```dockerfile
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
```
and re-build. If it still fails, swap `argon2` → `@node-rs/argon2` (prebuilt Rust; API: `hash(password)` / `verify(hash, password)`) and adjust imports. Record what you did.

- [ ] **Step 2: Write the failing test `src/auth/api-key.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, verifyApiKey, prefixOf } from './api-key.js';

describe('api-key helpers', () => {
  it('generates op_live_ keys with a 12-char prefix', () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith('op_live_')).toBe(true);
    expect(prefix).toHaveLength(12);
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefixOf(key)).toBe(prefix);
  });

  it('hash + verify round-trips; wrong key fails', async () => {
    const { key } = generateApiKey();
    const hash = await hashApiKey(key);
    expect(await verifyApiKey(hash, key)).toBe(true);
    expect(await verifyApiKey(hash, key + 'x')).toBe(false);
  });
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Write `src/auth/api-key.ts`** (helpers only; resolver + issue added in later steps/tasks)

```ts
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const PREFIX_LEN = 12; // 'op_live_' (8) + 4 chars of the random part

export function generateApiKey(): { key: string; prefix: string } {
  const rand = randomBytes(32).toString('base64url');
  const key = `op_live_${rand}`;
  return { key, prefix: key.slice(0, PREFIX_LEN) };
}

export function prefixOf(key: string): string {
  return key.slice(0, PREFIX_LEN);
}

export function hashApiKey(key: string): Promise<string> {
  return argon2.hash(key, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
}

export function verifyApiKey(hash: string, key: string): Promise<boolean> {
  return argon2.verify(hash, key).catch(() => false);
}
```

- [ ] **Step 5: Run, expect PASS** (`npm test -- api-key`). Then full `npm test`, `npm run typecheck`, `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/auth/api-key.ts src/auth/api-key.test.ts package.json package-lock.json Dockerfile
git commit -m "feat(phase6): api-key format + argon2id hash/verify helpers"
```

---

## Task 2: Migration 0011 — `api_keys` + `resolve_api_key`

**Files:**
- Create: `migrations/0011_api_keys.sql`
- Modify: `migrations/meta/_journal.json`, `src/db/schema.ts`
- Create: `tests/integration/db/api-keys-migration.test.ts`

- [ ] **Step 1: Write `migrations/0011_api_keys.sql`**

```sql
CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  prefix             text NOT NULL,
  hash               text NOT NULL,
  name               text NOT NULL,
  created_by_user_id uuid,
  scopes             text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_keys_isolation ON api_keys
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON api_keys TO app_role;
CREATE INDEX api_keys_prefix ON api_keys (prefix);

CREATE FUNCTION resolve_api_key(p_prefix text)
  RETURNS TABLE (id uuid, tenant_id uuid, hash text, scopes text[], expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, hash, scopes, expires_at, revoked_at FROM api_keys WHERE prefix = p_prefix;
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO app_role;
```

- [ ] **Step 2: Journal entry** `{ "idx": 10, "version": "5", "when": 1748600000000, "tag": "0011_api_keys", "breakpoints": true }`.

- [ ] **Step 3: Schema mirror** in `src/db/schema.ts`:

```ts
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull(),
  name: text('name').notNull(),
  createdByUserId: uuid('created_by_user_id'),
  scopes: text('scopes').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
```

- [ ] **Step 4: Integration test `tests/integration/db/api-keys-migration.test.ts`** — insert a key under RLS; `resolve_api_key(prefix)` returns it (cross-tenant, called as app_role); RLS scopes a direct select.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';

const T = '00000000-0000-0000-0000-00000000aa01';

describe('migration 0011 api_keys + resolve_api_key', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => {
    fixture = await startPostgres(); const m = await migratedDb(fixture.url); pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]); } finally { c.release(); }
    await runAsTenant(pool, T, async (c) => {
      await c.query(`INSERT INTO api_keys (tenant_id, prefix, hash, name, scopes)
                     VALUES ($1,'op_live_abcd','$argon2id$hash','k1', ARRAY['mcp:read'])`, [T]);
    });
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('resolve_api_key returns the candidate by prefix (cross-tenant, app_role)', async () => {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string; scopes: string[] }>(
        'SELECT * FROM resolve_api_key($1)', ['op_live_abcd']);
      expect(r.rows[0]?.tenant_id).toBe(T);
      expect(r.rows[0]?.scopes).toEqual(['mcp:read']);
    } finally { c.release(); }
  });
});
```

- [ ] **Step 5: Run** `npm run test:integration -- api-keys-migration && npm run typecheck`. **Commit:**

```bash
git add migrations/0011_api_keys.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/api-keys-migration.test.ts
git commit -m "feat(phase6): migration 0011 — api_keys table + resolve_api_key SECURITY DEFINER"
```

---

## Task 3: `issueApiKey` + `createApiKeyResolver`

**Files:**
- Modify: `src/auth/api-key.ts`
- Create: `tests/integration/auth/api-key.test.ts`

- [ ] **Step 1: Add `issueApiKey` + `createApiKeyResolver` to `src/auth/api-key.ts`**

```ts
import type pg from 'pg';
import type { Principal } from './principal.js';

export interface IssuedKey { id: string; key: string; prefix: string; }

/** Issues a key under the caller's already-set tenant context (RLS). Returns the plaintext ONCE. */
export async function issueApiKey(
  client: pg.PoolClient,
  input: { tenantId: string; name: string; scopes: string[]; createdByUserId?: string },
): Promise<IssuedKey> {
  const { key, prefix } = generateApiKey();
  const hash = await hashApiKey(key);
  const r = await client.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, prefix, hash, name, scopes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.tenantId, prefix, hash, input.name, input.scopes, input.createdByUserId ?? null],
  );
  return { id: r.rows[0]!.id, key, prefix };
}

export type ApiKeyResolver = (presentedKey: string) => Promise<Principal | null>;

export function createApiKeyResolver(pool: pg.Pool): ApiKeyResolver {
  return async (presentedKey) => {
    if (!presentedKey.startsWith('op_live_')) return null;
    const prefix = prefixOf(presentedKey);
    const client = await pool.connect();
    try {
      await client.query('SET ROLE app_role');
      const candidates = await client.query<{
        id: string; tenant_id: string; hash: string; scopes: string[];
        expires_at: Date | null; revoked_at: Date | null;
      }>('SELECT * FROM resolve_api_key($1)', [prefix]);
      for (const c of candidates.rows) {
        if (!(await verifyApiKey(c.hash, presentedKey))) continue;
        if (c.revoked_at) return null;
        if (c.expires_at && c.expires_at.getTime() < Date.now()) return null;
        // best-effort last_used_at under the key's tenant context
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE app_role');
          await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', c.tenant_id]);
          await client.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [c.id]);
          await client.query('COMMIT');
        } catch { await client.query('ROLLBACK').catch(() => {}); }
        return { kind: 'service', tenantId: c.tenant_id, apiKeyId: c.id, subject: `apikey:${c.id}`, scopes: c.scopes };
      }
      return null;
    } finally {
      client.release();
    }
  };
}
```

- [ ] **Step 2: Integration test `tests/integration/auth/api-key.test.ts`** — issue a key under tenant context, then `createApiKeyResolver` authenticates it → service Principal; wrong key → null; revoked → null; expired → null.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { issueApiKey, createApiKeyResolver } from '../../../src/auth/api-key.js';

const T = '00000000-0000-0000-0000-00000000aa02';

describe('api-key resolver (integration)', () => {
  let fixture: PgFixture; let pool: pg.Pool; let issued: { id: string; key: string };
  beforeAll(async () => {
    fixture = await startPostgres(); const m = await migratedDb(fixture.url); pool = m.pool;
    const c = await pool.connect();
    try { await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'t')`, [T]); } finally { c.release(); }
    await runAsTenant(pool, T, async (c) => {
      issued = await issueApiKey(c, { tenantId: T, name: 'k', scopes: ['mcp:read', 'mcp:write'] });
    });
  }, 60_000);
  afterAll(async () => { await pool.end(); await fixture.stop(); });

  it('authenticates a valid key → service Principal', async () => {
    const resolve = createApiKeyResolver(pool);
    const p = await resolve(issued.key);
    expect(p?.kind).toBe('service');
    if (p?.kind === 'service') { expect(p.tenantId).toBe(T); expect(p.scopes).toContain('mcp:write'); }
  });
  it('rejects a wrong key', async () => {
    expect(await createApiKeyResolver(pool)(issued.key + 'x')).toBeNull();
  });
  it('rejects a revoked key', async () => {
    await runAsTenant(pool, T, async (c) => {
      await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [issued.id]);
    });
    expect(await createApiKeyResolver(pool)(issued.key)).toBeNull();
  });
});
```

- [ ] **Step 3: Run** `npm run test:integration -- auth/api-key && npm run typecheck && npm run lint`. Add `src/auth/api-key.ts` issue/resolver paths are integration-tested; keep the unit-tested helpers covered (no coverage exclude needed unless thresholds dip — if so exclude `src/auth/api-key.ts`). **Commit:**

```bash
git add src/auth/api-key.ts tests/integration/auth/api-key.test.ts vitest.config.ts
git commit -m "feat(phase6): issueApiKey + createApiKeyResolver (argon2 verify, revoke/expiry checks)"
```

---

## Task 4: Wire the `op_live_` branch + service effective-role

**Files:**
- Modify: `src/auth/identity.ts`, `src/auth/identity.test.ts`
- Modify: `src/server.ts`
- Modify: `tests/integration/mcp/e2e.test.ts`

- [ ] **Step 1: Update `src/auth/identity.ts`** — add `apiKeyResolver?: ApiKeyResolver` to config; replace the `op_live_` throw:

```ts
import type { ApiKeyResolver } from './api-key.js';
// config: apiKeyResolver?: ApiKeyResolver

if (token.startsWith('op_live_')) {
  if (!config.apiKeyResolver) return null;
  return config.apiKeyResolver(token);   // returns service Principal or null
}
```

- [ ] **Step 2: Update `src/auth/identity.test.ts`** — replace the "throws for API key path" test with: a faked `apiKeyResolver` returns a service principal for a known key; resolver returning null → resolve returns null.

```ts
it('resolves an op_live_ key via the apiKeyResolver', async () => {
  const resolve = createIdentityResolver({
    devToken: 'dev', devPrincipal: { kind: 'user', tenantId: 't', userId: 'u', subject: 'dev', scopes: [], role: 'owner' },
    apiKeyResolver: (k) => k === 'op_live_good'
      ? Promise.resolve({ kind: 'service', tenantId: 'tnt', apiKeyId: 'ak', subject: 'apikey:ak', scopes: ['mcp:read'] })
      : Promise.resolve(null),
  });
  const p = await resolve('Bearer op_live_good');
  expect(p?.kind).toBe('service');
});
it('returns null for an unknown op_live_ key', async () => {
  const resolve = createIdentityResolver({
    devToken: 'dev', devPrincipal: { kind: 'user', tenantId: 't', userId: 'u', subject: 'dev', scopes: [], role: 'owner' },
    apiKeyResolver: () => Promise.resolve(null),
  });
  expect(await resolve('Bearer op_live_nope')).toBeNull();
});
```

- [ ] **Step 3: Wire in `src/server.ts`** — `const apiKeyResolver = createApiKeyResolver(pool);` passed into `createMcpServer`/`createIdentityResolver`. In the dispatchFactory's policy evaluation, derive the effective role for a service principal: where the code reads `p.kind === 'user' ? p.role : 'viewer'`, change the service branch to `p.scopes.includes('mcp:write') ? 'operator' : 'viewer'`. (Search the dispatchFactory + confirm.propose for `role:` derivation and apply consistently.)

- [ ] **Step 4: E2E in `tests/integration/mcp/e2e.test.ts`** — add a scenario: issue a key (via `issueApiKey` under the tenant), construct the test server with `apiKeyResolver: createApiKeyResolver(pool)`, then call `/mcp` `tools/list` + `check_domain` with `Authorization: Bearer <key>` (Nock the Openprovider login+check) → works; a revoked key → 401.

- [ ] **Step 5: Run** `npm test && npm run test:integration -- mcp/e2e && npm run typecheck && npm run lint`. **Commit:**

```bash
git add src/auth/identity.ts src/auth/identity.test.ts src/server.ts tests/integration/mcp/e2e.test.ts
git commit -m "feat(phase6): op_live_ API-key auth path + service effective-role; e2e key→/mcp"
```

---

# PART 2 — Single-Owner Dashboard (Tasks 5–10)

## Task 5: Shared `onboard-credentials` helper

**Files:**
- Create: `src/tenants/onboard-credentials.ts`
- Modify: `scripts/tenant-onboard.ts`
- Create: `tests/integration/tenants/onboard-credentials.test.ts`

- [ ] **Step 1: Write `src/tenants/onboard-credentials.ts`**

```ts
import type pg from 'pg';
import type { Kms } from '../secrets/kms.js';
import { createSecretsStore } from '../secrets/store.js';
import { createDbSecretsRepo } from '../secrets/db-repo.js';

export async function onboardCredentials(
  deps: { client: pg.PoolClient; kms: Kms; kmsKeyName: string },
  input: { tenantId: string; username: string; password: string },
): Promise<void> {
  await deps.client.query(
    `INSERT INTO openprovider_accounts (tenant_id, username)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET username = EXCLUDED.username, status = 'connected'`,
    [input.tenantId, input.username],
  );
  const store = createSecretsStore({ kms: deps.kms, kmsKeyArn: deps.kmsKeyName, repo: createDbSecretsRepo(deps.client) });
  await store.put(input.tenantId, 'openprovider.password', Buffer.from(input.password, 'utf8'));
}
```

- [ ] **Step 2: Refactor `scripts/tenant-onboard.ts`** to call `onboardCredentials({ client, kms, kmsKeyName: cfg.gcpKmsKeyName }, { tenantId, username, password })` instead of its inline insert+store logic.

- [ ] **Step 3: Integration test `tests/integration/tenants/onboard-credentials.test.ts`** — under tenant context with `createFakeKms()`, call `onboardCredentials`, then read back: `openprovider_accounts.username` set + `status='connected'`, and `tenant_secrets` has the encrypted `openprovider.password` (decrypt via the store → matches input).

- [ ] **Step 4: Run** `npm run test:integration -- onboard-credentials && npm run typecheck && npm run lint`. **Commit:**

```bash
git add src/tenants/onboard-credentials.ts scripts/tenant-onboard.ts tests/integration/tenants/onboard-credentials.test.ts
git commit -m "feat(phase6): shared onboard-credentials helper (CLI + dashboard reuse)"
```

---

## Task 6: Dashboard scaffold — session, CSRF, WorkOS login, mount

**Files:**
- Create: `src/dashboard/session.ts`, `src/dashboard/server.ts`
- Create: `src/dashboard/views/layout.eta`, `src/dashboard/views/login.eta`
- Create: `src/dashboard/session.test.ts`
- Modify: `src/server.ts` (mount the dashboard)

- [ ] **Step 1: Install deps**

```bash
npm install @fastify/view eta @fastify/cookie @fastify/formbody @fastify/static
```

- [ ] **Step 2: Write `src/dashboard/session.ts`** — signed-cookie session shape + `requireSession` preHandler + CSRF helpers. (Session payload is a signed JSON cookie; `@fastify/cookie` with a secret signs it.)

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';

export interface DashboardSession { tenantId: string; userId: string; subject: string; csrf: string; }

const COOKIE = 'op_dash';

export function setSession(reply: FastifyReply, s: Omit<DashboardSession, 'csrf'>): string {
  const csrf = randomBytes(16).toString('hex');
  const value = JSON.stringify({ ...s, csrf });
  void reply.setCookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', path: '/', signed: true, secure: false });
  return csrf;
}

export function readSession(req: FastifyRequest): DashboardSession | null {
  const raw = req.cookies[COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try { return JSON.parse(unsigned.value) as DashboardSession; } catch { return null; }
}

export function clearSession(reply: FastifyReply): void {
  void reply.clearCookie(COOKIE, { path: '/' });
}

/** preHandler: redirect to login if no session; else stash it on req. */
export function requireSession(req: FastifyRequest, reply: FastifyReply, done: (e?: Error) => void): void {
  const s = readSession(req);
  if (!s) { void reply.redirect('/dashboard/login'); return; }
  (req as FastifyRequest & { session?: DashboardSession }).session = s;
  done();
}

export function assertCsrf(req: FastifyRequest): boolean {
  const s = readSession(req);
  const body = req.body as { _csrf?: string } | undefined;
  return !!s && !!body?._csrf && body._csrf === s.csrf;
}
```

- [ ] **Step 3: Write `src/dashboard/server.ts`** — registers `@fastify/cookie` (secret from config), `@fastify/formbody`, `@fastify/view` (eta, root `src/dashboard/views`), `@fastify/static` (htmx vendored at `src/dashboard/public`), and the login routes. Accepts deps: `{ workos: { authorizationUrl, authenticateWithCode }, resolveTenant, withTenantConn }`.

```ts
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import { Eta } from 'eta';
import path from 'node:path';
import { setSession, clearSession } from './session.js';

export interface DashboardDeps {
  cookieSecret: string;
  buildAuthorizationUrl: () => string;            // WorkOS hosted login URL
  authenticateWithCode: (code: string) => Promise<{ userId: string; email: string; subject: string }>;
  resolveTenant: (subject: string, email: string) => Promise<{ tenantId: string; userId: string }>;
  registerPages: (app: FastifyInstance) => void;  // Tasks 7–8 attach page routes
}

export async function registerDashboard(app: FastifyInstance, deps: DashboardDeps): Promise<void> {
  const viewsDir = path.join(import.meta.dirname, 'views');
  await app.register(fastifyCookie, { secret: deps.cookieSecret });
  await app.register(fastifyFormbody);
  await app.register(fastifyView, { engine: { eta: new Eta({ views: viewsDir }) }, root: viewsDir, viewExt: 'eta' });
  await app.register(fastifyStatic, { root: path.join(import.meta.dirname, 'public'), prefix: '/dashboard/static/' });

  app.get('/dashboard/login', async (_req, reply) => reply.redirect(deps.buildAuthorizationUrl()));

  app.get('/dashboard/login/callback', async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    if (!code) { void reply.code(400); return reply.view('login', { error: 'missing code' }); }
    const user = await deps.authenticateWithCode(code);
    const t = await deps.resolveTenant(user.subject, user.email);
    setSession(reply, { tenantId: t.tenantId, userId: t.userId, subject: user.subject });
    return reply.redirect('/dashboard');
  });

  app.post('/dashboard/logout', async (_req, reply) => { clearSession(reply); return reply.redirect('/dashboard/login'); });

  deps.registerPages(app);
}
```

> The `import.meta.dirname` requires Node 20.11+ (we pin 20.11.1) — available. If unavailable, derive from `fileURLToPath(import.meta.url)`.

- [ ] **Step 4: Write `layout.eta` + `login.eta`** (compact):

`src/dashboard/views/layout.eta`:
```html
<!doctype html><html><head><meta charset="utf-8"><title>Openprovider MCP</title>
<script src="/dashboard/static/htmx.min.js"></script></head>
<body><header><a href="/dashboard">Overview</a> | <a href="/dashboard/openprovider">Openprovider</a> |
<a href="/dashboard/policy">Policy</a> | <a href="/dashboard/keys">API Keys</a> |
<a href="/dashboard/audit">Audit</a> | <a href="/dashboard/confirmations">Confirmations</a> |
<form method="post" action="/dashboard/logout" style="display:inline"><button>Logout</button></form></header>
<main><%~ it.body %></main></body></html>
```
`src/dashboard/views/login.eta`:
```html
<!doctype html><html><body><h1>Sign in</h1>
<% if (it.error) { %><p style="color:red"><%= it.error %></p><% } %>
<a href="/dashboard/login">Continue with WorkOS</a></body></html>
```

Vendor htmx: download `htmx.min.js` into `src/dashboard/public/` (or `npm install htmx.org` and copy `dist/htmx.min.js` in the build; simplest: commit the file). Document the source/version in a comment file `src/dashboard/public/README.md`.

- [ ] **Step 5: Write `src/dashboard/session.test.ts`** (unit) — `setSession`/`readSession` round-trip with a mocked reply/req carrying signed cookies; `requireSession` redirects when no cookie; `assertCsrf` true only when body token matches session token. Use light fakes for `FastifyRequest`/`Reply` (cookie sign/unsign can be tested via `@fastify/cookie`'s `signerFactory` or by faking `unsignCookie`).

- [ ] **Step 6: Mount in `src/server.ts`** — after `createMcpServer` returns the app, call `await registerDashboard(app, { cookieSecret: cfg.dashboardCookieSecret, buildAuthorizationUrl, authenticateWithCode, resolveTenant, registerPages })`. Add `DASHBOARD_COOKIE_SECRET` to config (+ `.env.example`). `buildAuthorizationUrl`/`authenticateWithCode` wrap `@workos-inc/node`'s AuthKit (authorization URL + `userManagement.authenticateWithCode`). `registerPages` is provided by Tasks 7–8.

> **App-composition note:** `createMcpServer` returns the Fastify instance; the dashboard registers onto that same instance in `server.ts` before `app.listen`. No second server.

- [ ] **Step 7: Run** `npm test -- session && npm run typecheck && npm run lint && npm run build`. **Commit:**

```bash
git add src/dashboard/ src/server.ts package.json package-lock.json .env.example
git commit -m "feat(phase6): dashboard scaffold — eta+cookie session+CSRF, WorkOS login, mount on app"
```

---

## Task 7: Pages — overview, Openprovider credentials, policy

**Files:**
- Create: `src/dashboard/routes/overview.ts`, `openprovider.ts`, `policy.ts`
- Create: `src/dashboard/views/{overview,openprovider,policy}.eta`
- Create: `tests/integration/dashboard/pages-core.test.ts`

- [ ] **Step 1: Implement the three route modules** — each exports a function that registers its routes with `requireSession` as preHandler and uses an injected `withTenantConn(session, fn)` that opens the RLS-scoped transaction (BEGIN + SET LOCAL ROLE app_role + set_config tenant). Full handler code:
  - `overview.ts`: `GET /dashboard` → query `openprovider_accounts.status` + policy spend cap + `liveSpendCents` → render `overview`.
  - `openprovider.ts`: `GET /dashboard/openprovider` renders the form (username pre-filled from `openprovider_accounts`, password blank); `POST` → `assertCsrf` → `onboardCredentials({client, kms, kmsKeyName}, {tenantId, username, password})` → redirect with success.
  - `policy.ts`: `GET /dashboard/policy` renders current policy JSON in a textarea; `POST` → `assertCsrf` → `JSON.parse` + `PolicyDoc.parse` → `upsertPolicy`; on parse/zod error re-render with the message inline.

  (Provide the complete handler + eta for each — they follow the session/withTenantConn/CSRF pattern; the implementer writes them per the spec §8. Keep each route file focused.)

- [ ] **Step 2: Integration test `pages-core.test.ts`** — boot the app with a faked session cookie + `createFakeKms`; assert: `GET /dashboard/openprovider` 200 renders the form; `POST` with a valid CSRF token persists creds (ciphertext in `tenant_secrets`); `POST /dashboard/policy` with bad JSON re-renders with an error (200, body contains the error) and does NOT change the stored policy; valid policy save round-trips.

- [ ] **Step 3: Run** `npm run test:integration -- dashboard/pages-core && npm run typecheck && npm run lint`. **Commit:**

```bash
git add src/dashboard/routes/overview.ts src/dashboard/routes/openprovider.ts src/dashboard/routes/policy.ts src/dashboard/views/overview.eta src/dashboard/views/openprovider.eta src/dashboard/views/policy.eta tests/integration/dashboard/pages-core.test.ts
git commit -m "feat(phase6): dashboard overview + Openprovider creds + policy pages"
```

---

## Task 8: Pages — API keys, audit viewer, confirmations

**Files:**
- Create: `src/dashboard/routes/keys.ts`, `audit.ts`, `confirmations.ts`
- Create: `src/dashboard/views/{keys,audit,confirmations}.eta`
- Create: `tests/integration/dashboard/pages-manage.test.ts`

- [ ] **Step 1: Implement the three route modules:**
  - `keys.ts`: `GET /dashboard/keys` lists `api_keys` (prefix, name, last_used, status from revoked_at/expires_at); `POST /dashboard/keys/issue` → `assertCsrf` → `issueApiKey(client, {tenantId, name, scopes: ['mcp:read','mcp:write'], createdByUserId})` → render an htmx partial showing the plaintext key ONCE; `POST /dashboard/keys/:id/revoke` → `assertCsrf` → `UPDATE api_keys SET revoked_at=now()` → htmx row swap.
  - `audit.ts`: `GET /dashboard/audit?event_type=&tool=&limit=&offset=` → paginated `audit_events` query (RLS-scoped, newest first) → render table; `GET /dashboard/audit/export` → stream NDJSON (`Content-Disposition: attachment`) of the tenant's audit rows.
  - `confirmations.ts`: `GET /dashboard/confirmations` → query pending (consumed_at IS NULL, expires_at > now()) → render list; `POST /dashboard/confirmations/:id/approve` → `assertCsrf` → call the same consume path used by `confirm_pending` (factor the server's `confirmPendingConsume` into a reusable function the dashboard can call with the session's principal-equivalent) → htmx swap.

  > For `confirmations` approve: the dashboard needs the same `confirmPendingConsume` logic from `server.ts`. Factor it into a small reusable unit the dashboard route imports (or expose a `confirmController` from the dispatchFactory wiring). Avoid duplicating the validate+claim+execute+settle logic.

- [ ] **Step 2: Integration test `pages-manage.test.ts`** — faked session: issue a key (response shows a `op_live_` plaintext once), list shows the prefix, revoke flips status; audit page renders seeded rows tenant-scoped + export returns NDJSON; a pending confirmation (seeded via the repo) appears and approve drives the consume path (reservation committed).

- [ ] **Step 3: Run** `npm run test:integration -- dashboard/pages-manage && npm run typecheck && npm run lint`. **Commit:**

```bash
git add src/dashboard/routes/keys.ts src/dashboard/routes/audit.ts src/dashboard/routes/confirmations.ts src/dashboard/views/keys.eta src/dashboard/views/audit.eta src/dashboard/views/confirmations.eta tests/integration/dashboard/pages-manage.test.ts
git commit -m "feat(phase6): dashboard API-keys + audit viewer + confirmations approval pages"
```

---

## Task 9: E2E — dashboard issue-key → authenticate `/mcp`

**Files:**
- Modify: `tests/integration/mcp/e2e.test.ts`

- [ ] **Step 1: Add a scenario** that ties Part 1 + Part 2: with a fake-WorkOS dashboard session cookie, `POST /dashboard/keys/issue` to mint a key, extract the plaintext from the htmx response, then call `/mcp` `tools/call check_domain` with `Authorization: Bearer <that key>` (Nock the Openprovider login + check) → success. Then `POST /dashboard/keys/:id/revoke` and assert the same key now yields 401 on `/mcp`.

- [ ] **Step 2: Run** `npm run test:integration -- mcp/e2e && npm run test:integration` (full). All green. **Commit:**

```bash
git add tests/integration/mcp/e2e.test.ts
git commit -m "test(phase6): e2e dashboard issue-key → authenticate /mcp → revoke → 401"
```

---

## Task 10: README + CHANGELOG + `v0.8.0-phase6` tag (local only)

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Update `README.md`** — status → Phase 6; document the dashboard (`/dashboard`, WorkOS login, the page set), API keys (`op_live_`, issue via dashboard, single-show), `DASHBOARD_COOKIE_SECRET` env var; note single-owner (RBAC/invitation deferred).

- [ ] **Step 2: Prepend `## [0.8.0-phase6] — 2026-05-27` to `CHANGELOG.md`**

```markdown
## [0.8.0-phase6] — 2026-05-27

### Added
- API-key authentication: api_keys table + resolve_api_key SECURITY DEFINER + the op_live_ path (argon2id), producing a service Principal. Keys issued single-show; revoke/expiry enforced.
- Service principals map to an effective policy role (mcp:write→operator, else viewer); they can never approve confirmations.
- Single-owner dashboard (Fastify + eta + htmx, WorkOS hosted login + signed-cookie session + CSRF): overview, Openprovider credential onboarding, policy editor, API-key issue/list/revoke, audit-log viewer + NDJSON export, pending-confirmation approval.
- Shared onboard-credentials helper used by both the tenant:onboard CLI and the dashboard form.

### Deferred
- Multi-user invitation + full RBAC (Phase 6b — dashboard is single-owner).
- SSO/SAML/SCIM; dashboard theming; API-key scope narrowing in the UI.
```

- [ ] **Step 3: Commit + tag (DO NOT PUSH)**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(phase6): CHANGELOG + README for 0.8.0-phase6"
git tag -a v0.8.0-phase6 -m "Phase 6: API keys + single-owner dashboard"
```

- [ ] **Step 4: Verify** `git tag --list 'v0.*'` shows all prior + `v0.8.0-phase6`; `git status` clean; `npm run lint` exit 0. **DO NOT PUSH.**

---

## Phase 6 exit checklist

- [ ] `op_live_` keys authenticate `/mcp` end-to-end; revoked/expired → 401; service principal maps to effective role and can't approve confirmations.
- [ ] Dashboard: WorkOS login → session; creds form encrypts+persists; policy editor validates+saves; keys issue (single-show)/list/revoke; audit viewer + export; confirmation approval drives the consume path.
- [ ] CSRF enforced on all state-changing POSTs; secrets never rendered.
- [ ] `docker build` succeeds with argon2 (build-deps added if needed, recorded).
- [ ] `npm test` + `npm run test:integration` green; typecheck + lint clean.
- [ ] CHANGELOG `0.8.0-phase6` + tag created locally.

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 api_keys table | 2 |
| §3 key format + issuance | 1, 3 |
| §4 resolve_api_key | 2 |
| §5 op_live_ auth path | 3, 4 |
| §6 service effective-role | 4 |
| §7 session + stack | 6 |
| §8 pages | 7, 8 |
| §9 error handling + CSRF | 6 (CSRF), 7 (inline errors) |
| §10 shared helper | 5 |
| §11 tests | 1–9 |

**Placeholder scan:** Tasks 7–8 describe the three route modules' behavior precisely (route, method, action, template) but defer the literal eta/handler line-by-line to the implementer following the established session/withTenantConn/CSRF pattern — this is the one area that's behavior-spec rather than copy-paste code, because there are 6 near-identical CRUD pages and the pattern is fully shown in Task 6 (session) + Task 5 (the helper they call) + the repo functions (existing). If strict copy-paste is required, the implementer expands each per the pattern; the contract (routes, RLS, CSRF, which existing function each calls) is unambiguous. No "TBD".

**Type consistency:** `generateApiKey`/`hashApiKey`/`verifyApiKey`/`prefixOf`/`issueApiKey`/`createApiKeyResolver`/`ApiKeyResolver` (Tasks 1,3) used in identity (Task 4) + dashboard keys page (Task 8). `DashboardSession`/`requireSession`/`assertCsrf`/`setSession` (Task 6) used by all page routes (7,8). `onboardCredentials` (Task 5) used by the CLI + the openprovider page (Task 7). `apiKeys` schema mirror (Task 2) matches the issue/resolve queries. The `confirmPendingConsume` reuse (Task 8) references the Phase-4/5 server function — flagged to factor rather than duplicate.

**Note folded in:** Task 8's confirmation-approval reuses the server's `confirmPendingConsume` — the implementer must factor that into a shared unit (not duplicate the validate+claim+execute+settle), keeping a single source of truth for the consume path.

*End of Phase 6 plan.*

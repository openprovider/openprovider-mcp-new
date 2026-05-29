# Phase-8 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 7-item Phase-8 hardening backlog: OP code-196 mapping, cookie secure-flag env-gating, login rate-limit, read-only `auditor` role, audit-chain test robustness, property fuzz + soak, and GHCR push + keyless cosign + SBOM attestation.

**Architecture:** Mostly small, isolated changes to existing modules (token-manager, dashboard session/server, policy engine, roles). One new role threaded through 3 definition sites + a migration. fast-check property suites co-located with the units. A standalone soak script. CI workflow extended for supply-chain signing.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, Fastify, `@fastify/rate-limit`, Vitest, fast-check (already a dep), autocannon (new devDep), Postgres + testcontainers, GitHub Actions + cosign + syft.

**Spec:** `docs/superpowers/specs/2026-05-29-phase8-hardening-design.md`. **Branch:** `feat/enterprise-phase-1` (HEAD `589d7f8`). Single push at the end → `0.12.0-phase8`.

**Commands:** unit `npx vitest run <path>`; integration `npx vitest run --config vitest.integration.config.ts <path>`; `npm run typecheck`; `npm run lint`.

---

## File map

| File | Task | Change |
|---|---|---|
| `src/openprovider/token-manager.ts` + `.test.ts` | 1 | map OP `code:196` → `OpenproviderAuthError` |
| `src/config.ts` + `src/config.test.ts` | 2 | derive `cookieSecure` from `NODE_ENV`/`DASHBOARD_COOKIE_SECURE` |
| `src/dashboard/session.ts` + `.test.ts` | 2 | `setSession` takes `{ secure }` |
| `src/dashboard/server.ts` | 2,3 | thread `cookieSecure`; register rate-limit on login |
| `src/server.ts` | 2 | pass `cfg.cookieSecure` into `registerDashboard` |
| `tests/integration/dashboard/login-rate-limit.test.ts` | 3 | new |
| `src/auth/roles.ts`, `src/auth/principal.ts`, `src/policies/schema.ts`, `src/policies/engine.ts` | 4 | add `auditor` |
| `migrations/0021_auditor_role.sql` + `migrations/meta/_journal.json` | 4 | extend role CHECK constraints |
| `src/policies/engine.test.ts`, `tests/integration/db/auditor-role.test.ts` | 4 | tests |
| `tests/integration/db/audit-chain.test.ts` | 5 | dedicated pool / robustness |
| `src/policies/engine.fuzz.test.ts`, `src/openprovider/redact.fuzz.test.ts`, `src/policies/pricing/pricing.fuzz.test.ts`, `src/policies/repo.fuzz.test.ts` | 6 | new fast-check suites |
| `scripts/soak.mjs`, `README.md`, `package.json` | 7 | soak script + autocannon devDep |
| `.github/workflows/ci.yml` | 8 | GHCR push + cosign sign + attest + verify |
| `package.json`, `CHANGELOG.md` | 9 | bump 0.12.0-phase8 |

---

## Task 1: Openprovider code-196 → invalid-credentials

**Files:** Modify `src/openprovider/token-manager.ts`; Test `src/openprovider/token-manager.test.ts`.

The current `login()` reads the body only after the `!res.ok` check, so OP's bad-credentials response (HTTP 500 with `{code:196}`) hits the generic `login failed: 500`. Read the body first, check `code === 196` (covers 200 and 500), then fall back.

- [ ] **Step 1: Write failing tests.** Open `src/openprovider/token-manager.test.ts` (it exists; match its `fetchImpl`-mock style — `createOpenproviderTokenManager({ fetchImpl, fetchCredentials, cache })`). Append:

```ts
it('maps OP code 196 (HTTP 500 body) to OpenproviderAuthError', async () => {
  const tm = createOpenproviderTokenManager({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ code: 196, desc: 'bad creds' }), { status: 500 })) as typeof fetch,
    fetchCredentials: async () => ({ username: 'u', password: 'p' }),
    cache: { get: async () => null, set: async () => {}, clear: async () => {} },
  });
  await expect(tm.getToken('t1')).rejects.toMatchObject({ name: 'OpenproviderAuthError' });
});

it('maps OP code 196 returned with HTTP 200 to OpenproviderAuthError', async () => {
  const tm = createOpenproviderTokenManager({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ code: 196 }), { status: 200 })) as typeof fetch,
    fetchCredentials: async () => ({ username: 'u', password: 'p' }),
    cache: { get: async () => null, set: async () => {}, clear: async () => {} },
  });
  await expect(tm.getToken('t2')).rejects.toMatchObject({ name: 'OpenproviderAuthError' });
});

it('returns the token on a normal success body', async () => {
  const tm = createOpenproviderTokenManager({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ code: 0, data: { token: 'TKN' } }), { status: 200 })) as typeof fetch,
    fetchCredentials: async () => ({ username: 'u', password: 'p' }),
    cache: { get: async () => null, set: async () => {}, clear: async () => {} },
  });
  await expect(tm.getToken('t3')).resolves.toBe('TKN');
});

it('keeps the generic error for an unexpected non-196 failure', async () => {
  const tm = createOpenproviderTokenManager({
    fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch,
    fetchCredentials: async () => ({ username: 'u', password: 'p' }),
    cache: { get: async () => null, set: async () => {}, clear: async () => {} },
  });
  await expect(tm.getToken('t4')).rejects.toThrow('login failed: 503');
});
```
(If the existing test file constructs the manager differently, mirror that — the key is the four behaviors.)

- [ ] **Step 2: Run → fail.** `npx vitest run src/openprovider/token-manager.test.ts` — the 196 cases throw the generic error / the success-with-code-196 returns a token instead of throwing.

- [ ] **Step 3: Implement.** In `src/openprovider/token-manager.ts`, replace the body of `login()` from the status checks down to the token read:

```ts
    if (res.status === 401) throw new OpenproviderAuthError('invalid Openprovider credentials');
    const body = (await res.json().catch(() => ({}))) as {
      code?: number;
      data?: { token?: string };
    };
    // Openprovider reports bad credentials as code 196, sometimes with a non-401 status
    // (observed HTTP 500) or even a 200 envelope. Map it explicitly.
    if (body.code === 196) {
      throw new OpenproviderAuthError('invalid Openprovider credentials');
    }
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    const token = body.data?.token;
    if (!token) throw new Error('login response missing data.token');
```
(The rest — `expiresAt`, `cache.set`, `return token` — is unchanged.)

- [ ] **Step 4: Run → pass.** `npx vitest run src/openprovider/token-manager.test.ts`; then `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/openprovider/token-manager.ts src/openprovider/token-manager.test.ts
git commit -m "fix(token-manager): map Openprovider code 196 to invalid-credentials error"
```

---

## Task 2: Cookie secure-flag env-gating

**Files:** Modify `src/config.ts` (+ `src/config.test.ts`), `src/dashboard/session.ts` (+ `src/dashboard/session.test.ts`), `src/dashboard/server.ts`, `src/server.ts`.

- [ ] **Step 1: Write failing config test.** In `src/config.test.ts` (create if absent; if present, append), assert the derivation:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://x', GCP_PROJECT_ID: 'p', GCP_KMS_KEY_NAME: 'k',
  GCS_BUCKET: 'b', DEV_BEARER_TOKEN: 'd', DASHBOARD_COOKIE_SECRET: 's',
};

describe('cookieSecure derivation', () => {
  it('defaults to true in production', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).cookieSecure).toBe(true);
  });
  it('defaults to false in dev', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).cookieSecure).toBe(false);
  });
  it('explicit DASHBOARD_COOKIE_SECURE=true overrides dev', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development', DASHBOARD_COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
  });
  it('explicit DASHBOARD_COOKIE_SECURE=false overrides production', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production', DASHBOARD_COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run src/config.test.ts` — `cookieSecure` undefined.

- [ ] **Step 3: Implement config.** In `src/config.ts`: add to the zod schema `DASHBOARD_COOKIE_SECURE: z.string().optional(),` and in the returned object add:

```ts
    cookieSecure:
      parsed.DASHBOARD_COOKIE_SECURE !== undefined
        ? parsed.DASHBOARD_COOKIE_SECURE === 'true'
        : parsed.NODE_ENV === 'production',
```

- [ ] **Step 4: Write failing session test.** In `src/dashboard/session.test.ts`, append (it has a fake-reply helper capturing `setCookie` opts — reuse it):

```ts
it('setSession emits secure:true when configured', () => {
  const reply = makeReply(); // existing helper that captures setCookie opts
  setSession(reply as never, { tenantId: 't', userId: 'u', subject: 's', role: 'owner' }, { secure: true });
  expect(reply._cookies['op_dash'].opts.secure).toBe(true);
});
it('setSession defaults secure:false when not configured', () => {
  const reply = makeReply();
  setSession(reply as never, { tenantId: 't', userId: 'u', subject: 's', role: 'owner' });
  expect(reply._cookies['op_dash'].opts.secure).toBe(false);
});
```
(Use whatever the file's fake-reply builder is actually named.)

- [ ] **Step 5: Run → fail.**

- [ ] **Step 6: Implement session.** In `src/dashboard/session.ts`, change `setSession`’s signature + the `secure` line:

```ts
export function setSession(
  reply: FastifyReply,
  s: Omit<DashboardSession, 'csrf'>,
  opts: { secure?: boolean } = {},
): string {
  const csrf = randomBytes(16).toString('hex');
  const value = JSON.stringify({ ...s, csrf });
  void reply.setCookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    signed: true,
    secure: opts.secure ?? false,
  });
  return csrf;
}
```

- [ ] **Step 7: Thread it through.** In `src/dashboard/server.ts`: add `cookieSecure: boolean;` to `DashboardDeps`, and at the login + signup `setSession(...)` call sites pass `{ secure: deps.cookieSecure }` as the third arg. (Search the file for every `setSession(` — there are two: login at ~L75 and signup further down. Update both.) In `src/server.ts`, where `registerDashboard(app, { ... })` is called, add `cookieSecure: cfg.cookieSecure,` to the deps object.

- [ ] **Step 8: Run → pass + typecheck.** `npx vitest run src/config.test.ts src/dashboard/session.test.ts`; `npm run typecheck`; `npx vitest run` (full unit — confirm no caller breakage).

- [ ] **Step 9: Commit.**
```bash
git add src/config.ts src/config.test.ts src/dashboard/session.ts src/dashboard/session.test.ts src/dashboard/server.ts src/server.ts
git commit -m "feat(dashboard): env-gate session cookie secure flag (prod-default, DASHBOARD_COOKIE_SECURE override)"
```

---

## Task 3: Login rate-limit (5/min per IP)

**Files:** Modify `src/dashboard/server.ts`; Test `tests/integration/dashboard/login-rate-limit.test.ts` (new).

`@fastify/rate-limit` is already a dependency. Register it on the dashboard app with `global: false`, then attach a per-route limit to `POST /dashboard/login`.

- [ ] **Step 1: Write failing test.** Create `tests/integration/dashboard/login-rate-limit.test.ts`. Uses `app.inject` (no real socket, no Postgres — login dep mocked):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDashboard } from '../../../src/dashboard/server.js';

describe('login rate-limit', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    await registerDashboard(app, {
      cookieSecret: 'test-secret-32-chars-long-aaaaaa!!',
      cookieSecure: false,
      signup: async () => ({ status: 'invalid_password' }),
      login: async () => ({ ok: false }),
      registerPages: () => {},
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('allows 5 attempts then 429s the 6th from one IP', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/x-www-form-urlencoded' };
    const payload = 'email=a@b.c&password=wrong';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: 'POST', url: '/dashboard/login', headers, payload });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it('a different IP is unaffected', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/login',
      headers: { 'x-forwarded-for': '198.51.100.9', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a@b.c&password=wrong',
    });
    expect(r.statusCode).toBe(401);
  });
});
```
Note: `app.inject` reports `req.ip` from `x-forwarded-for` only if `trustProxy` is set. To keep the test independent of that, the limiter's `keyGenerator` should use `req.ip`; in the test, set `Fastify({ trustProxy: true })` so `x-forwarded-for` drives `req.ip`. Update the `beforeAll` to `Fastify({ trustProxy: true })`.

- [ ] **Step 2: Run → fail.** `npx vitest run --config vitest.integration.config.ts tests/integration/dashboard/login-rate-limit.test.ts` — all 6 return 401 (no limit yet).

- [ ] **Step 3: Implement.** In `src/dashboard/server.ts`:
  - Add import: `import rateLimit from '@fastify/rate-limit';`
  - After the other `app.register(...)` calls in `registerDashboard`, add: `await app.register(rateLimit, { global: false });`
  - Change the login route to carry a per-route limit + replace the `TODO` comment:

```ts
  app.post(
    '/dashboard/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
      const r = await deps.login((email ?? '').trim().toLowerCase(), password ?? '');
      if (!r.ok) {
        void reply.code(401);
        return reply.view('login', { error: 'Invalid email or password', notice: null });
      }
      setSession(
        reply,
        { tenantId: r.tenantId, userId: r.userId, subject: r.email, role: r.role, email: r.email },
        { secure: deps.cookieSecure },
      );
      return reply.redirect('/dashboard');
    },
  );
```
(This also folds in the Task-2 `{ secure: deps.cookieSecure }` change — keep them consistent.)

- [ ] **Step 4: Run → pass.** Integration test green. `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/dashboard/server.ts tests/integration/dashboard/login-rate-limit.test.ts
git commit -m "feat(dashboard): rate-limit POST /dashboard/login to 5/min per IP"
```

---

## Task 4: `auditor` read-only role

**Files:** Modify `src/auth/roles.ts`, `src/auth/principal.ts`, `src/policies/schema.ts`, `src/policies/engine.ts`; Create `migrations/0021_auditor_role.sql`; Modify `migrations/meta/_journal.json`; Test `src/policies/engine.test.ts`, `tests/integration/db/auditor-role.test.ts`.

- [ ] **Step 1: Write failing engine unit tests.** Append to `src/policies/engine.test.ts` (it imports `resolveToolMode`/`evaluate` from `./engine.js`; build a minimal `PolicyDoc` like the file's existing tests do):

```ts
describe('auditor role (read-only)', () => {
  // reuse the file's existing policy fixture builder; assume `mkPolicy()` exists or inline one
  const policy = mkPolicy(); // DEFAULT_POLICY-shaped doc with list_*/get_* allow wildcards
  it('auditor is allowed read tools', () => {
    expect(resolveToolMode(policy, 'list_domains', 'auditor')).toBe('allow');
    expect(resolveToolMode(policy, 'get_domain', 'auditor')).toBe('allow');
    expect(resolveToolMode(policy, 'check_domain', 'auditor')).toBe('allow');
  });
  it('auditor is denied every write/confirm tool', () => {
    for (const t of ['register_domain', 'create_dns_zone', 'delete_domain', 'create_ssl_order', 'create_contact']) {
      expect(resolveToolMode(policy, t, 'auditor')).toBe('deny');
    }
  });
  it('evaluate denies auditor a write tool with insufficient_role', () => {
    const d = evaluate({ toolName: 'register_domain', args: {}, role: 'auditor', policy, liveSpendCents: 0, estimatedCostCents: 0, tldsInArgs: [] });
    expect(d).toMatchObject({ decision: 'deny', reason: 'insufficient_role' });
  });
});
```
(If the existing tests use a specific helper to build a policy, reuse it verbatim instead of `mkPolicy()`.)

- [ ] **Step 2: Run → fail.** `npx vitest run src/policies/engine.test.ts` — `'auditor'` isn’t a valid `Role` (type error) and/or not gated.

- [ ] **Step 3: Add the role to all 3 definition sites.**
  - `src/auth/roles.ts`:
    ```ts
    export type Role = 'owner' | 'admin' | 'operator' | 'viewer' | 'auditor';
    export const ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'operator', 'viewer', 'auditor']);
    ```
  - `src/auth/principal.ts`: change the user role union to `role: 'owner' | 'admin' | 'operator' | 'viewer' | 'auditor';`
  - `src/policies/schema.ts`: `export const RoleEnum = z.enum(['owner', 'admin', 'operator', 'viewer', 'auditor']);`

- [ ] **Step 4: Gate auditor like viewer in the engine.** In `src/policies/engine.ts`, update both checks:
  - `resolveToolMode` line: `if ((role === 'viewer' || role === 'auditor') && !(mode === 'allow' && isReadTool(toolName))) return 'deny';`
  - `evaluate` line: `if ((input.role === 'viewer' || input.role === 'auditor') && !(mode === 'allow' && isReadTool(input.toolName))) { return { decision: 'deny', reason: 'insufficient_role' }; }`

- [ ] **Step 5: Run → engine tests pass.** `npx vitest run src/policies/engine.test.ts`; `npm run typecheck`.

- [ ] **Step 6: Write failing migration test.** Create `tests/integration/db/auditor-role.test.ts` (mirror `tests/integration/db/tags-policy.test.ts` harness — `startPostgres` + `migratedDb`):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';

describe('migration 0021 auditor role', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => { fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool; }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  it('users.role accepts auditor', async () => {
    const t = '00000000-0000-0000-0000-0000000000a1';
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'x') ON CONFLICT DO NOTHING`, [t]);
      await expect(
        c.query(`INSERT INTO users (tenant_id,email,role) VALUES ($1,'a@x.io','auditor')`, [t]),
      ).resolves.toBeTruthy();
      await expect(
        c.query(`INSERT INTO users (tenant_id,email,role) VALUES ($1,'b@x.io','bogus')`, [t]),
      ).rejects.toThrow();
    } finally { c.release(); }
  });
});
```
(Adjust the `users` insert columns to the real NOT-NULL set — check `migrations/0002_create_users.sql`; `oauth_subject`/`password_hash` are nullable post-0013, so the minimal insert above should satisfy constraints. If a NOT NULL column is missing, add it.)

- [ ] **Step 7: Run → fail** (constraint rejects `auditor`).

- [ ] **Step 8: Create `migrations/0021_auditor_role.sql`:**
```sql
-- Add the read-only `auditor` role to the users + invitations role CHECK constraints.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner','admin','operator','viewer','auditor'));

ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('admin','operator','viewer','auditor'));
```
**Before finalizing**, confirm the actual constraint names: run `migratedDb` then `SELECT conname FROM pg_constraint WHERE conrelid='users'::regclass AND contype='c';` (Postgres auto-names them `users_role_check` / `invitations_role_check`, but verify — if different, use the real names). Append a journal entry to `migrations/meta/_journal.json`: `idx: 20`, `tag: "0021_auditor_role"`, copying the field shape (version/when/breakpoints) of the idx-19 `0020_license_policy` entry; bump `when`.

- [ ] **Step 9: Run → pass.** `npx vitest run --config vitest.integration.config.ts tests/integration/db/auditor-role.test.ts`; `npm run typecheck`; `npx vitest run` (full unit green).

- [ ] **Step 10: Commit.**
```bash
git add src/auth/roles.ts src/auth/principal.ts src/policies/schema.ts src/policies/engine.ts src/policies/engine.test.ts migrations/0021_auditor_role.sql migrations/meta/_journal.json tests/integration/db/auditor-role.test.ts
git commit -m "feat(rbac): add read-only auditor role (migration 0021)"
```

---

## Task 5: Audit-chain test robustness (investigation-led)

**Files:** Modify `tests/integration/db/audit-chain.test.ts` (and only the chain code in `migrations/0010_audit_chain.sql` / `src/audit/pg-sink.ts` IF a genuine race is found).

The per-tenant advisory lock already exists (`migrations/0010_audit_chain.sql`). The "concurrent inserts produce an unbroken linear chain" test passes in isolation but flakes under full-suite parallel load — strongly suggesting connection-pool / container contention, not a chain defect. Use **superpowers:systematic-debugging**.

- [ ] **Step 1: Reproduce.** Run the full integration suite a few times to capture a real failure:
```bash
for i in 1 2 3; do npx vitest run --config vitest.integration.config.ts 2>&1 | grep -E "audit-chain|FAIL|chain"; done
```
Record whether the failing assertion is the chain-link assertion (`prev_hash.equals(prev row_hash)` — a genuine race) OR a timeout / pool-acquire error (environmental).

- [ ] **Step 2a (expected path — environmental): give the test a dedicated pool.** In `tests/integration/db/audit-chain.test.ts`, instead of sharing the suite pool for the 8 concurrent inserts, create a dedicated `pg.Pool` sized for the concurrency in `beforeAll` and use it for the concurrent-insert test, closing it in `afterAll`:

```ts
import pg from 'pg';
// inside describe:
let chainPool: pg.Pool;
beforeAll(async () => {
  // …existing fixture/migratedDb setup…
  chainPool = new pg.Pool({ connectionString: fixture.url, max: 20 });
}, 120_000);
afterAll(async () => {
  await chainPool?.end();
  // …existing teardown…
});
```
Use `chainPool` in the `Promise.all([...])` of the concurrent test, and bump the concurrency 8 → 16 to prove the lock holds under more pressure. Keep the 30 s timeout (or raise to 60 s).

- [ ] **Step 2b (only if a genuine race is found): fix the insert path.** If Step 1 shows actual chain breakage, the `pg_advisory_xact_lock` isn't serializing because the chained inserts aren't each in a transaction that holds the lock to commit. Ensure `insertEvent` (or `pg-sink`) runs each insert inside a transaction (`BEGIN … INSERT … COMMIT`) so the `BEFORE INSERT` trigger's xact lock is held until the row is committed and visible to the next waiter. Add a regression comment referencing this task.

- [ ] **Step 3: Prove stability.** Run the single test 10× consecutively; all green:
```bash
for i in $(seq 1 10); do npx vitest run --config vitest.integration.config.ts tests/integration/db/audit-chain.test.ts -t "unbroken linear chain" 2>&1 | tail -1; done
```
Then run the FULL integration suite once to confirm no regression.

- [ ] **Step 4: Commit.**
```bash
git add tests/integration/db/audit-chain.test.ts
# include migrations/0010_audit_chain.sql or src/audit/pg-sink.ts ONLY if Step 2b applied
git commit -m "test(audit-chain): isolate concurrent-insert test on a dedicated pool to remove suite-contention flake"
```

---

## Task 6: Property fuzz suites (fast-check, CI)

**Files:** Create `src/policies/engine.fuzz.test.ts`, `src/openprovider/redact.fuzz.test.ts`, `src/policies/pricing/pricing.fuzz.test.ts`, `src/policies/repo.fuzz.test.ts`. `fast-check` is already a dependency. Keep `numRuns: 200`.

- [ ] **Step 1: engine.fuzz.test.ts.**
```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveToolMode, isReadTool, evaluate } from './engine.js';
import { ruleFor, type PolicyDoc } from './schema.js';

const toolArb = fc.constantFrom(
  'list_domains', 'get_domain', 'check_domain', 'suggest_domain',
  'register_domain', 'create_dns_zone', 'delete_domain', 'create_ssl_order',
  'create_contact', 'create_plesk_license', 'trade_domain',
);
function policyArb(): fc.Arbitrary<PolicyDoc> {
  return fc.record({
    version: fc.constant(1),
    tools: fc.constant({ 'list_*': 'allow', 'get_*': 'allow', 'check_*': 'allow', 'suggest_*': 'allow', register_domain: 'confirm', create_dns_zone: 'allow', delete_domain: 'confirm', create_ssl_order: 'confirm', create_contact: 'allow', create_plesk_license: 'confirm' }),
    spend_caps: fc.record({ limit_eur: fc.double({ min: 0, max: 1000, noNaN: true }) }),
    tld_allowlist: fc.constant([]), tld_denylist: fc.constant([]), ip_allowlist: fc.constant([]),
  }) as unknown as fc.Arbitrary<PolicyDoc>;
}

describe('policy engine — properties', () => {
  it('viewer and auditor never get a non-read tool', () => {
    fc.assert(fc.property(policyArb(), toolArb, fc.constantFrom('viewer', 'auditor'), (p, t, role) => {
      const m = resolveToolMode(p, t, role as never);
      if (!isReadTool(t)) expect(m).toBe('deny');
    }), { numRuns: 200 });
  });
  it('evaluate never allows when reservation exceeds the cap', () => {
    fc.assert(fc.property(policyArb(), fc.nat(500_00), fc.nat(500_00), (p, live, est) => {
      const d = evaluate({ toolName: 'register_domain', args: {}, role: 'operator', policy: p, liveSpendCents: live, estimatedCostCents: est, tldsInArgs: [] });
      const limit = Math.round(p.spend_caps.limit_eur * 100);
      if (est > 0 && live + est > limit) expect(d).toMatchObject({ decision: 'deny', reason: 'spend_cap_exceeded' });
    }), { numRuns: 200 });
  });
  it('ruleFor picks the longest matching wildcard', () => {
    const p = { tools: { 'get_*': 'allow', 'get_secret_*': 'confirm' } } as unknown as PolicyDoc;
    fc.assert(fc.property(fc.string(), (s) => {
      const name = 'get_secret_' + s.replace(/[^a-z_]/g, '');
      expect(ruleFor(p, name)).toBe('confirm');
    }), { numRuns: 200 });
  });
});
```
Adjust `PolicyDoc` field names to the real schema (check `src/policies/schema.ts` — e.g. whether it's `spend_caps.limit_eur`, `tld_allowlist`, etc.; the engine code in this repo uses exactly those names).

- [ ] **Step 2: redact.fuzz.test.ts.**
```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { redactContactPii } from './redact.js';

const SENSITIVE = ['secret_key', 'username', 'auth_type', 'api_access_enabled', 'password_changed_at', 'last_login_at'];
const contactArb = fc.record({
  id: fc.integer(), email: fc.string(), name: fc.object(),
  secret_key: fc.string(), username: fc.string(), auth_type: fc.string(),
  api_access_enabled: fc.boolean(), password_changed_at: fc.string(), last_login_at: fc.string(),
}, { requiredKeys: ['id'] });

describe('redactContactPii — properties', () => {
  it('never emits a sensitive key', () => {
    fc.assert(fc.property(contactArb, (c) => {
      const out = redactContactPii(c) as Record<string, unknown>;
      for (const k of SENSITIVE) expect(out).not.toHaveProperty(k);
    }), { numRuns: 200 });
  });
  it('is idempotent', () => {
    fc.assert(fc.property(contactArb, (c) => {
      const once = redactContactPii(c);
      expect(redactContactPii(once)).toEqual(once);
    }), { numRuns: 200 });
  });
  it('redacts every entry in a results envelope', () => {
    fc.assert(fc.property(fc.array(contactArb, { maxLength: 6 }), (arr) => {
      const out = redactContactPii({ results: arr, total: arr.length }) as { results: Record<string, unknown>[] };
      for (const r of out.results) for (const k of SENSITIVE) expect(r).not.toHaveProperty(k);
    }), { numRuns: 200 });
  });
});
```

- [ ] **Step 3: pricing.fuzz.test.ts.** Import the shared `clientWith` fixture (`./__fixtures/op-client.js`) and `createPricing` from `./index.js`. Properties: a non-EUR currency always throws `unsupported_currency`; a valid EUR price yields a non-negative integer cents value. Example:
```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createPricing } from './index.js';
import { clientWith } from './__fixtures/op-client.js';

describe('pricing — properties', () => {
  it('register_domain price is a non-negative integer for EUR', async () => {
    await fc.assert(fc.asyncProperty(fc.double({ min: 0, max: 9999, noNaN: true }), fc.integer({ min: 1, max: 10 }), async (price, period) => {
      const pricing = createPricing({ client: clientWith({ price, currency: 'EUR' }) });
      const cents = await pricing.price('register_domain', { domain: { name: 'x', extension: 'com' }, period }, 'tok');
      expect(Number.isInteger(cents)).toBe(true);
      expect(cents).toBeGreaterThanOrEqual(0);
    }), { numRuns: 100 });
  });
  it('non-EUR always throws unsupported_currency', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('USD', 'GBP', 'JPY'), async (cur) => {
      const pricing = createPricing({ client: clientWith({ price: 10, currency: cur }) });
      await expect(pricing.price('register_domain', { domain: { name: 'x', extension: 'com' }, period: 1 }, 'tok')).rejects.toMatchObject({ code: 'unsupported_currency' });
    }), { numRuns: 50 });
  });
});
```

- [ ] **Step 4: repo.fuzz.test.ts.** `canonicalArgsHash(args, tenantId): Buffer` from `./repo.js`. Properties: equal objects with keys in different insertion order hash equal; different tenant ids hash different:
```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { canonicalArgsHash } from './repo.js';

describe('canonicalArgsHash — properties', () => {
  it('is key-order independent', () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.uuid(), (obj, tid) => {
      const a = canonicalArgsHash(obj, tid);
      const reordered = Object.fromEntries(Object.entries(obj).reverse());
      expect(canonicalArgsHash(reordered, tid).equals(a)).toBe(true);
    }), { numRuns: 200 });
  });
  it('different tenant salts differ', () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
      expect(canonicalArgsHash(obj, 'tenant-a').equals(canonicalArgsHash(obj, 'tenant-b'))).toBe(false);
    }), { numRuns: 200 });
  });
});
```
(If `canonicalArgsHash` has a different signature, adapt — confirm in `src/policies/repo.ts`.)

- [ ] **Step 5: Run all four → green.** `npx vitest run src/policies/engine.fuzz.test.ts src/openprovider/redact.fuzz.test.ts src/policies/pricing/pricing.fuzz.test.ts src/policies/repo.fuzz.test.ts`. Fix any property that surfaces a real bug by fixing the CODE (not weakening the property); if a property reveals only a test-arbitrary mismatch, fix the arbitrary. `npm run typecheck`; `npx vitest run` (full).

- [ ] **Step 6: Commit.**
```bash
git add src/policies/engine.fuzz.test.ts src/openprovider/redact.fuzz.test.ts src/policies/pricing/pricing.fuzz.test.ts src/policies/repo.fuzz.test.ts
git commit -m "test(fuzz): fast-check property suites for policy engine, redaction, pricing, args-hash"
```

---

## Task 7: Soak script (autocannon, manual)

**Files:** Create `scripts/soak.mjs`; Modify `package.json` (devDep + script); Modify `README.md`.

- [ ] **Step 1: Add autocannon devDep.**
```bash
npm install --save-dev autocannon
```

- [ ] **Step 2: Create `scripts/soak.mjs`:**
```js
#!/usr/bin/env node
// Manual soak test — NOT run in CI. Drives a running MCP server's /mcp tools/list
// (a benign authenticated read) and reports p50/p99 latency + RSS delta.
//
// Usage: node scripts/soak.mjs --url http://localhost:3000 --token <bearer> --duration 60 --connections 20
import autocannon from 'autocannon';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const url = arg('url', 'http://localhost:3000');
const token = arg('token', process.env.DEV_BEARER_TOKEN ?? '');
const duration = Number(arg('duration', '60'));
const connections = Number(arg('connections', '20'));
if (!token) {
  console.error('Provide --token <bearer> or set DEV_BEARER_TOKEN');
  process.exit(1);
}

const rssStart = process.memoryUsage().rss;
const instance = autocannon({
  url: `${url}/mcp`,
  connections,
  duration,
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
autocannon.track(instance, { renderProgressBar: true });
instance.on('done', (result) => {
  const rssEnd = process.memoryUsage().rss;
  console.log('\n--- soak summary ---');
  console.log(`requests: ${result.requests.total}, non-2xx: ${result.non2xx}`);
  console.log(`latency p50=${result.latency.p50}ms p99=${result.latency.p99}ms max=${result.latency.max}ms`);
  console.log(`driver RSS delta: ${((rssEnd - rssStart) / 1e6).toFixed(1)} MB`);
});
```

- [ ] **Step 3: Add a package.json script.** Add to `"scripts"`: `"soak": "node scripts/soak.mjs"`.

- [ ] **Step 4: Document in README.** Add a "Soak testing" subsection: how to start the server, then `npm run soak -- --token <bearer> --duration 60 --connections 20`, and that it's manual (not CI) because load tests are environment-sensitive. Note that it hits the read-only `tools/list` so it never mutates anything.

- [ ] **Step 5: Verify the script loads (no run needed).** `node --check scripts/soak.mjs` (syntax check). `npm run typecheck` (unaffected — .mjs not in tsc). `npx vitest run` (unaffected).

- [ ] **Step 6: Commit.**
```bash
git add scripts/soak.mjs package.json package-lock.json README.md
git commit -m "test(soak): add autocannon soak script for /mcp tools/list (manual, not CI)"
```

---

## Task 8: CI — GHCR push + keyless cosign + SBOM attestation (CI-only verified)

**Files:** Modify `.github/workflows/ci.yml`.

The `build` job already builds the image, generates a CycloneDX SBOM, and installs cosign. Complete it: push to GHCR (gated to main + tags), keyless-sign the pushed digest, attest the SBOM, and verify.

- [ ] **Step 1: Edit the workflow.** Add `packages: write` to the top-level `permissions` (keep `contents: read`, `id-token: write`). Replace the `build` job with:

```yaml
  build:
    runs-on: ubuntu-latest
    needs: test
    permissions:
      contents: read
      id-token: write
      packages: write
    env:
      IMAGE: ghcr.io/${{ github.repository }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: sigstore/cosign-installer@v3
      - name: Log in to GHCR
        if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build (and push on main/tags)
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: ${{ github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/') }}
          tags: |
            ${{ env.IMAGE }}:${{ github.sha }}
            ${{ startsWith(github.ref, 'refs/tags/') && format('{0}:{1}', env.IMAGE, github.ref_name) || '' }}
      - name: Generate SBOM (CycloneDX)
        uses: anchore/sbom-action@v0
        with:
          image: ${{ env.IMAGE }}:${{ github.sha }}
          format: cyclonedx-json
          output-file: sbom.cdx.json
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: sbom.cdx.json
      - name: Sign + attest (keyless) on main/tags
        if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          cosign sign --yes "${IMAGE}@${DIGEST}"
          cosign attest --yes --predicate sbom.cdx.json --type cyclonedx "${IMAGE}@${DIGEST}"
      - name: Verify signature + attestation on main/tags
        if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          cosign verify "${IMAGE}@${DIGEST}" \
            --certificate-identity-regexp "https://github.com/${{ github.repository }}/.github/workflows/.*" \
            --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
          cosign verify-attestation "${IMAGE}@${DIGEST}" --type cyclonedx \
            --certificate-identity-regexp "https://github.com/${{ github.repository }}/.github/workflows/.*" \
            --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```
Keep the existing `test` job unchanged.

- [ ] **Step 2: Lint the YAML locally.** `npx --yes yaml-lint .github/workflows/ci.yml` (or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`). There is no local way to exercise keyless signing — it runs only in GitHub Actions with the OIDC token. The real verification is a green `build` job on a `main` push.

- [ ] **Step 3: Commit.**
```bash
git add .github/workflows/ci.yml
git commit -m "ci: push image to GHCR, keyless cosign sign + CycloneDX SBOM attestation + verify (main/tags)"
```

---

## Task 9: Release bump → 0.12.0-phase8

**Files:** Modify `package.json`, `CHANGELOG.md`.

- [ ] **Step 1: Bump version.** In `package.json`, `"version": "0.11.0-api-coverage"` → `"version": "0.12.0-phase8"`.

- [ ] **Step 2: CHANGELOG.** Add a new `## [0.12.0-phase8] — 2026-05-29` section above the prior release, summarizing the 7 items:
```markdown
## [0.12.0-phase8] — 2026-05-29

### Added
- Read-only `auditor` RBAC role (migration 0021): allowed read tools, denied all writes/confirms — for compliance / break-glass read access.
- `@fastify/rate-limit` on `POST /dashboard/login` (5/min per IP).
- fast-check property-fuzz suites for the policy engine, contact redaction, pricing, and the canonical args hash (run in CI).
- `scripts/soak.mjs` (autocannon) for manual soak testing of `/mcp tools/list`.
- CI: image pushed to GHCR, keyless `cosign` signature + CycloneDX SBOM attestation, verified in-workflow (main + tags).

### Changed
- Dashboard session cookie `secure` flag is env-gated: defaults to `NODE_ENV==='production'`, overridable by `DASHBOARD_COOKIE_SECURE`.

### Fixed
- Token manager maps Openprovider error code 196 to `OpenproviderAuthError('invalid Openprovider credentials')` instead of a generic `login failed: <status>`.
- Audit-chain concurrent-insert integration test isolated onto a dedicated connection pool to remove suite-contention flake (the per-tenant advisory lock was already correct).
```

- [ ] **Step 3: FULL gate.**
```bash
npm run typecheck   # 0
npm run lint        # 0
npx vitest run      # unit green (incl. new fuzz suites)
npx vitest run --config vitest.integration.config.ts   # integration green (incl. auditor-role + rate-limit; live tests skip)
```

- [ ] **Step 4: Commit + STOP (do NOT push).**
```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): 0.12.0-phase8"
```
Report STATUS, the commit list (9 commits), and the full gate results. Push is held for the human's explicit "yes".

---

## Self-Review

**1. Spec coverage:** All 7 spec items → tasks: code-196 (T1), cookie-secure (T2), rate-limit (T3), auditor (T4), audit-chain (T5), fuzz+soak (T6+T7), cosign/SBOM (T8), release (T9). ✅

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to". Each code step has concrete code. The two "confirm the real name / adjust to the real signature" notes (constraint names in T4, `canonicalArgsHash`/`PolicyDoc` shapes in T6) are verification instructions with a concrete default given, not placeholders.

**3. Type consistency:** `Role` gains `'auditor'` in all 3 sites (roles.ts, principal.ts, schema.ts RoleEnum) consistently; the engine gate updates both `resolveToolMode` and `evaluate` with the same `(role === 'viewer' || role === 'auditor')` condition. `setSession(reply, s, { secure })` signature matches its two call sites in T2/T3 and `cookieSecure` flows config → DashboardDeps → setSession consistently. `DASHBOARD_COOKIE_SECURE` name consistent across config + tests + CHANGELOG. Migration `0021_auditor_role` / journal idx 20 consistent. ✅

*End of plan.*

# Phase 6c — Local Email+Password Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WorkOS OAuth with self-hosted email+password auth (signup, login, invite-accept-sets-password, admin-issued reset links, change-password) while keeping the Phase-6b invitation + RBAC model; `/mcp` becomes API-key-only.

**Architecture:** A new migration (0013) adds `password_hash` to `users`, a `password_resets` table, and SECURITY DEFINER functions (`signup_tenant`, `find_user_by_email`, re-signatured `accept_invitation`, `consume_password_reset`) that replace the OAuth-shaped `resolve_or_provision_tenant`. Argon2id (already used for API keys) hashes passwords. The dashboard serves local auth forms; WorkOS (verifier, hosted login, `@workos-inc/node`, `WORKOS_*` config) is deleted. RLS + the signed-cookie session + `requireRole` gating are unchanged.

**Tech Stack:** PostgreSQL (RLS + SECURITY DEFINER plpgsql), Drizzle (raw-SQL migrations), `pg`, Fastify 5 + eta + `@fastify/cookie`/`@fastify/formbody`/`@fastify/rate-limit`, argon2, Vitest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-27-phase6c-local-auth-design.md`
**Branch:** `feat/enterprise-phase-1`.

> **Build-goes-red note (like Phase 6b):** Tasks 4, 7, 8 break callers/tests that depend on the old `accept_invitation` signature, `resolve_or_provision_tenant`, and WorkOS. Those break-then-fix commits use `git commit --no-verify` (husky runs `tsc`). Task 13 makes the whole project typecheck + lint + test green; nothing is pushed until the user approves at Task 14.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `migrations/0013_local_auth.sql` | new | users columns; `password_resets`; drop `resolve_or_provision_tenant`; `signup_tenant`, `find_user_by_email`, re-signatured `accept_invitation`, `consume_password_reset`. |
| `migrations/meta/_journal.json` | mod | idx 12, tag `0013_local_auth`. |
| `src/db/schema.ts` | mod | `passwordResets` mirror (users isn't mirrored today — leave as-is). |
| `tests/integration/_helpers/db.ts` | mod | add `seedTenantOwner(pool,email,hash)` using `signup_tenant` (centralizes the seeding switch). |
| `src/auth/password.ts` | new | `hashPassword`/`verifyPassword`/`assertPasswordPolicy` (argon2id, min 12). |
| `src/auth/local-auth.ts` | new | `signup`/`findUserByEmail`/`acceptInvitation`/`consumePasswordReset` pool wrappers. |
| `src/auth/accept-invitation.ts` | mod | `acceptInvitation(pool, token, passwordHash)` new signature; keep `emailHasUser`. |
| `src/auth/identity.ts` | mod | drop the WorkOS verifier branch (dev token + API keys only). |
| `src/auth/oauth/workos.ts` + `workos.test.ts` | delete | — |
| `src/auth/tenant-resolver.ts` | delete | replaced by local-auth. |
| `src/dashboard/session.ts` | mod | drop the optional `pending` field (no pre-tenant sessions anymore). |
| `src/dashboard/server.ts` | mod | local `DashboardDeps`; signup/login/logout routes; no WorkOS. |
| `src/dashboard/routes/auth.ts` | new | accept / reset / change-password routes. |
| `src/dashboard/routes/users.ts` | mod | "Reset password" action. |
| `src/dashboard/views/{login,signup,accept,reset}.eta` | new/mod | local-auth forms. |
| `src/config.ts` | mod | remove `WORKOS_*`. |
| `src/server.ts` | mod | remove WorkOS wiring + `oauth` block + `verifier`/`resolveTenant`; wire local auth. |
| `package.json` | mod | remove `@workos-inc/node`. |
| `.env.example` | mod | remove `WORKOS_*`. |
| tests (multiple) | mod | switch seeding to `seedTenantOwner`; new auth tests; e2e. |

**Commands:** unit `npx vitest run <path>`; integration `npx vitest run --config vitest.integration.config.ts <path>`; typecheck `npm run typecheck`; lint `npm run lint`. Integration needs Docker. Container boot is ~50–70s — be patient; re-run a timed-out `beforeAll` once.

---

## Task 1: Migration 0013 — schema (users columns + password_resets)

**Files:** Create `migrations/0013_local_auth.sql`; Modify `migrations/meta/_journal.json`, `src/db/schema.ts`; Test `tests/integration/db/local-auth-migration.test.ts`.

- [ ] **Step 1: Write the failing test**
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';

describe('migration 0013 local auth schema', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => { fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool; }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  it('users has nullable password_hash and nullable oauth_subject', async () => {
    const c = await pool.connect();
    try {
      const r = await c.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name='users' AND column_name IN ('password_hash','oauth_subject')`,
      );
      const m = Object.fromEntries(r.rows.map((x) => [x.column_name, x.is_nullable]));
      expect(m['password_hash']).toBe('YES');
      expect(m['oauth_subject']).toBe('YES');
    } finally { c.release(); }
  });

  it('password_resets table exists with RLS', async () => {
    const c = await pool.connect();
    try {
      const t = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_name='password_resets'`);
      expect(t.rowCount).toBe(1);
      const rls = await c.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname='password_resets'`);
      expect(rls.rows[0]!.relforcerowsecurity).toBe(true);
    } finally { c.release(); }
  });
});
```

- [ ] **Step 2: Run → fail** `npx vitest run --config vitest.integration.config.ts tests/integration/db/local-auth-migration.test.ts` → FAIL (`password_resets` missing / column not nullable).

- [ ] **Step 3: Create `migrations/0013_local_auth.sql`** (schema portion only; functions added in Tasks 2–5):
```sql
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ALTER COLUMN oauth_subject DROP NOT NULL;
CREATE UNIQUE INDEX users_email_active ON users (lower(email)) WHERE status <> 'deleted';

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  token       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY password_resets_isolation ON password_resets
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON password_resets TO app_role;
CREATE UNIQUE INDEX password_resets_token ON password_resets (token);
```

- [ ] **Step 4: Journal** — append to `migrations/meta/_journal.json` entries (comma after the `0012` entry):
```json
    { "idx": 12, "version": "5", "when": 1748800000000, "tag": "0013_local_auth", "breakpoints": true }
```

- [ ] **Step 5: Drizzle mirror** — append to `src/db/schema.ts`:
```ts
export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  token: text('token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});
```
NOTE: `users` is not mirrored in `schema.ts` today (only the migration defines it). `passwordResets` references `users.id`; if `users` isn't an exported drizzle table, reference the table by a `pgTable('users', { id: uuid('id').primaryKey() })` minimal mirror OR drop the `.references()` (the FK is enforced in SQL regardless). Use the SQL-enforced FK and a plain `uuid('user_id').notNull()` without `.references()` to avoid adding a users mirror.

- [ ] **Step 6: Run → pass.** `npx vitest run --config vitest.integration.config.ts tests/integration/db/local-auth-migration.test.ts` + `npm run typecheck`.

- [ ] **Step 7: Commit**
```bash
git add migrations/0013_local_auth.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/local-auth-migration.test.ts
git commit -m "feat(phase6c): migration 0013 schema (password_hash + password_resets)"
```

---

## Task 2: `signup_tenant` (replace `resolve_or_provision_tenant`)

**Files:** Modify `migrations/0013_local_auth.sql` (append), `tests/integration/_helpers/db.ts`; Test `tests/integration/auth/signup.test.ts`.

The current default-policy JSON doc is in `migrations/0012_invitations.sql` (provision branch). **Read it from there and reuse it verbatim.**

- [ ] **Step 1: Add `seedTenantOwner` helper** to `tests/integration/_helpers/db.ts`:
```ts
export async function seedTenantOwner(
  pool: pg.Pool,
  email = 'owner@test.local',
  passwordHash = 'x-not-a-real-hash',
): Promise<{ status: string; tenant_id: string; user_id: string; role: string }> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query('SELECT * FROM signup_tenant($1, $2)', [email, passwordHash]);
    return r.rows[0];
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
}
```

- [ ] **Step 2: Write failing test** `tests/integration/auth/signup.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner } from '../_helpers/db.js';

describe('signup_tenant', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => { fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool; }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  it('provisions tenant + owner + default policy + password_hash', async () => {
    const r = await seedTenantOwner(pool, 'su-owner@example.com', 'hash-1');
    expect(r.status).toBe('created');
    expect(r.role).toBe('owner');
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const pol = await c.query(`SELECT 1 FROM policies WHERE tenant_id=$1`, [r.tenant_id]);
      expect(pol.rowCount).toBe(1);
      const u = await c.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [r.user_id]);
      expect(u.rows[0]!.password_hash).toBe('hash-1');
    } finally { c.release(); }
  });

  it('rejects a duplicate active email with email_taken', async () => {
    await seedTenantOwner(pool, 'dup@example.com', 'h');
    const again = await seedTenantOwner(pool, 'DUP@example.com', 'h2'); // case-insensitive
    expect(again.status).toBe('email_taken');
  });
});
```

- [ ] **Step 3: Run → fail** (`function signup_tenant does not exist`).

- [ ] **Step 4: Append to `migrations/0013_local_auth.sql`** (paste the exact `doc` JSON from 0012's provision branch):
```sql
DROP FUNCTION IF EXISTS resolve_or_provision_tenant(text, text);

CREATE FUNCTION signup_tenant(p_email text, p_password_hash text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_new_tenant_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email) AND status <> 'deleted') THEN
    RETURN QUERY SELECT 'email_taken'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  LOOP
    BEGIN
      v_new_tenant_id := gen_random_uuid();
      INSERT INTO tenants (id, name) VALUES (v_new_tenant_id, 'tenant for ' || p_email);
      INSERT INTO policies (tenant_id, doc)
        VALUES (v_new_tenant_id,
          '{"version":1,"spend_caps":{"window":"month","limit_eur":0},"tld_allowlist":[],"tld_denylist":[],"tools":{"list_*":"allow","get_*":"allow","check_domain":"allow","register_domain":"confirm","update_domain":"confirm","delete_contact":"confirm","update_contact":"confirm","create_contact":"allow"},"ip_allowlist":[]}'::jsonb);
      RETURN QUERY
        INSERT INTO users (tenant_id, email, password_hash, role)
        VALUES (v_new_tenant_id, p_email, p_password_hash, 'owner')
        RETURNING 'created'::text, users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- lost a race (email or tenant); subtransaction rolled back. Re-check + retry.
      IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email) AND status <> 'deleted') THEN
        RETURN QUERY SELECT 'email_taken'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN;
      END IF;
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION signup_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_tenant(text, text) TO app_role;
```
NOTE: `users` no longer has `oauth_subject` set here (it's nullable now). The default-policy doc must match 0012's verbatim.

- [ ] **Step 5: Run → pass.** `npx vitest run --config vitest.integration.config.ts tests/integration/auth/signup.test.ts`.

- [ ] **Step 6: Delete the obsolete resolver test.** `git rm tests/integration/auth/resolve-provision.test.ts` (it tested the dropped function).

- [ ] **Step 7: Commit (`--no-verify` — other suites still reference the old function; fixed in later tasks)**
```bash
git add migrations/0013_local_auth.sql tests/integration/_helpers/db.ts tests/integration/auth/signup.test.ts
git rm tests/integration/auth/resolve-provision.test.ts
git commit --no-verify -m "feat(phase6c): signup_tenant replaces resolve_or_provision_tenant"
```

---

## Task 3: `find_user_by_email`

**Files:** Modify `migrations/0013_local_auth.sql`; Test `tests/integration/auth/signup.test.ts` (add cases).

- [ ] **Step 1: Add failing cases** (append inside the `describe`):
```ts
  async function findByEmail(email: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query('SELECT * FROM find_user_by_email($1)', [email]);
      return r.rows[0];
    } finally { await c.query('RESET ROLE'); c.release(); }
  }
  it('find_user_by_email returns the row + hash for an active user (case-insensitive)', async () => {
    const s = await seedTenantOwner(pool, 'find-me@example.com', 'the-hash');
    const u = await findByEmail('FIND-ME@example.com');
    expect(u.user_id).toBe(s.user_id);
    expect(u.tenant_id).toBe(s.tenant_id);
    expect(u.role).toBe('owner');
    expect(u.password_hash).toBe('the-hash');
  });
  it('find_user_by_email returns nothing for an unknown email', async () => {
    expect(await findByEmail('ghost@example.com')).toBeUndefined();
  });
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Append the function:**
```sql
CREATE FUNCTION find_user_by_email(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role text, status text, password_hash text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT id, tenant_id, role, status, password_hash
    FROM users
   WHERE lower(email) = lower(p_email) AND status <> 'deleted'
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_by_email(text) TO app_role;
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit** `git add migrations/0013_local_auth.sql tests/integration/auth/signup.test.ts && git commit -m "feat(phase6c): find_user_by_email"` (no --no-verify needed; this file's suite is green).

---

## Task 4: Re-signature `accept_invitation(token, password_hash)`

**Files:** Modify `migrations/0013_local_auth.sql`; Modify `tests/integration/auth/invitations.test.ts` (update accept cases to the new signature + seed via `seedTenantOwner`).

The old `accept_invitation(token, subject, email)` lives in `migrations/0012_invitations.sql`. Migration 0013 **replaces** it.

- [ ] **Step 1: Update `invitations.test.ts`.** The file currently seeds the tenant in `beforeAll` via `resolve_or_provision_tenant` — change that to `seedTenantOwner(pool, 'owner@example.com')` (import it from `_helpers/db.js`) and use the returned `tenant_id`. Replace the `accept` helper + the accept-related `it`s with the new signature:
```ts
  async function accept(token: string, passwordHash: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query('SELECT * FROM accept_invitation($1, $2)', [token, passwordHash]);
      return r.rows[0]!;
    } finally { await c.query('RESET ROLE'); c.release(); }
  }
  it('accept creates the user with the invite email+role+password (tok-1 → operator)', async () => {
    const res = await accept('tok-1', 'invitee-hash');
    expect(res.status).toBe('accepted');
    expect(res.tenant_id).toBe(tenantId);
    expect(res.role).toBe('operator');
    const c = await pool.connect();
    try {
      await c.query('RESET ROLE');
      const u = await c.query<{ email: string; password_hash: string }>(
        `SELECT email, password_hash FROM users WHERE id=$1`, [res.user_id]);
      expect(u.rows[0]!.email).toBe('invitee@example.com');
      expect(u.rows[0]!.password_hash).toBe('invitee-hash');
    } finally { c.release(); }
  });
  it('accept rejects reuse → already_accepted', async () => { expect((await accept('tok-1','h')).status).toBe('already_accepted'); });
  it('accept rejects unknown token → invalid_token', async () => { expect((await accept('nope','h')).status).toBe('invalid_token'); });
  it('accept rejects expired', async () => {
    await runAsTenant(pool, tenantId, async (cl) => { await cl.query(
      `INSERT INTO invitations (tenant_id,email,role,token,expires_at) VALUES ($1,'exp@example.com','viewer','tok-exp', now()-interval '1 hour')`, [tenantId]); });
    expect((await accept('tok-exp','h')).status).toBe('expired');
  });
  it('accept rejects an email already taken → email_taken', async () => {
    // 'owner@example.com' is already an active user (the seeded owner)
    await runAsTenant(pool, tenantId, async (cl) => { await cl.query(
      `INSERT INTO invitations (tenant_id,email,role,token,expires_at) VALUES ($1,'owner@example.com','viewer','tok-taken', now()+interval '7 days')`, [tenantId]); });
    expect((await accept('tok-taken','h')).status).toBe('email_taken');
  });
  it('concurrent accept of one token creates exactly one user', async () => {
    await runAsTenant(pool, tenantId, async (cl) => { await cl.query(
      `INSERT INTO invitations (tenant_id,email,role,token,expires_at) VALUES ($1,'race@example.com','viewer','tok-race', now()+interval '7 days')`, [tenantId]); });
    const rs = await Promise.all([accept('tok-race','h'), accept('tok-race','h')]);
    expect(rs.filter((r) => r.status === 'accepted')).toHaveLength(1);
  });
```
Remove the old subject/email-match/already_member accept cases (no longer applicable). The migration-0012 invitations-table tests (insert/unique/CHECK) and `resolve_or_provision_tenant` cases in this file: **delete the `resolve_or_provision_tenant` cases** (function dropped); keep the table tests but seed via `seedTenantOwner`.

- [ ] **Step 2: Run → fail** (old 2-arg/3-arg accept gone; new signature missing).

- [ ] **Step 3: Append the replacement function** to `migrations/0013_local_auth.sql`:
```sql
DROP FUNCTION IF EXISTS accept_invitation(text, text, text);

CREATE FUNCTION accept_invitation(p_token text, p_password_hash text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_inv invitations%ROWTYPE; v_uid uuid;
BEGIN
  SELECT * INTO v_inv FROM invitations WHERE token = p_token;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_token'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  IF v_inv.accepted_at IS NOT NULL THEN RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  IF v_inv.expires_at <= now() THEN RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(v_inv.email) AND status <> 'deleted') THEN
    RETURN QUERY SELECT 'email_taken'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id AND accepted_at IS NULL;
  IF NOT FOUND THEN RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  INSERT INTO users (tenant_id, email, password_hash, role)
    VALUES (v_inv.tenant_id, v_inv.email, p_password_hash, v_inv.role)
    RETURNING id INTO v_uid;
  RETURN QUERY SELECT 'accepted'::text, v_inv.tenant_id, v_uid, v_inv.role;
END;
$$;
REVOKE ALL ON FUNCTION accept_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invitation(text, text) TO app_role;
```

- [ ] **Step 4: Run → pass** `npx vitest run --config vitest.integration.config.ts tests/integration/auth/invitations.test.ts`.

- [ ] **Step 5: Commit (`--no-verify` — the TS `acceptInvitation` wrapper + accept route still use the old signature; fixed in Tasks 7/12)**
```bash
git add migrations/0013_local_auth.sql tests/integration/auth/invitations.test.ts
git commit --no-verify -m "feat(phase6c): accept_invitation(token, password_hash)"
```

---

## Task 5: `consume_password_reset`

**Files:** Modify `migrations/0013_local_auth.sql`; Test `tests/integration/auth/password-reset.test.ts`.

- [ ] **Step 1: Write failing test:**
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, seedTenantOwner, runAsTenant } from '../_helpers/db.js';

describe('consume_password_reset', () => {
  let fixture: PgFixture; let pool: pg.Pool; let tenantId: string; let userId: string;
  beforeAll(async () => {
    fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool;
    const s = await seedTenantOwner(pool, 'pr-owner@example.com', 'old-hash');
    tenantId = s.tenant_id; userId = s.user_id;
    await runAsTenant(pool, tenantId, async (c) => { await c.query(
      `INSERT INTO password_resets (tenant_id,user_id,token,expires_at) VALUES ($1,$2,'pr-tok', now()+interval '1 hour')`, [tenantId,userId]); });
  }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  async function consume(token: string, hash: string) {
    const c = await pool.connect();
    try { await c.query('SET ROLE app_role');
      const r = await c.query('SELECT * FROM consume_password_reset($1,$2)', [token, hash]); return r.rows[0]!;
    } finally { await c.query('RESET ROLE'); c.release(); }
  }
  it('ok sets the new password hash and is single-use', async () => {
    const r = await consume('pr-tok', 'new-hash');
    expect(r.status).toBe('ok'); expect(r.user_id).toBe(userId);
    const c = await pool.connect();
    try { await c.query('RESET ROLE');
      const u = await c.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [userId]);
      expect(u.rows[0]!.password_hash).toBe('new-hash');
    } finally { c.release(); }
    expect((await consume('pr-tok', 'x')).status).toBe('already_used');
  });
  it('rejects unknown / expired', async () => {
    expect((await consume('nope', 'x')).status).toBe('invalid_token');
    await runAsTenant(pool, tenantId, async (c) => { await c.query(
      `INSERT INTO password_resets (tenant_id,user_id,token,expires_at) VALUES ($1,$2,'pr-exp', now()-interval '1 minute')`, [tenantId,userId]); });
    expect((await consume('pr-exp', 'x')).status).toBe('expired');
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Append the function:**
```sql
CREATE FUNCTION consume_password_reset(p_token text, p_password_hash text)
  RETURNS TABLE (status text, user_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_pr password_resets%ROWTYPE;
BEGIN
  SELECT * INTO v_pr FROM password_resets WHERE token = p_token;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_token'::text, NULL::uuid; RETURN; END IF;
  IF v_pr.used_at IS NOT NULL THEN RETURN QUERY SELECT 'already_used'::text, NULL::uuid; RETURN; END IF;
  IF v_pr.expires_at <= now() THEN RETURN QUERY SELECT 'expired'::text, NULL::uuid; RETURN; END IF;
  UPDATE password_resets SET used_at = now() WHERE id = v_pr.id AND used_at IS NULL;
  IF NOT FOUND THEN RETURN QUERY SELECT 'already_used'::text, NULL::uuid; RETURN; END IF;
  UPDATE users SET password_hash = p_password_hash WHERE id = v_pr.user_id;
  RETURN QUERY SELECT 'ok'::text, v_pr.user_id;
END;
$$;
REVOKE ALL ON FUNCTION consume_password_reset(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_password_reset(text, text) TO app_role;
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `git add migrations/0013_local_auth.sql tests/integration/auth/password-reset.test.ts && git commit -m "feat(phase6c): consume_password_reset"`.

---

## Task 6: `src/auth/password.ts`

**Files:** Create `src/auth/password.ts`; Test `src/auth/password.test.ts`.

- [ ] **Step 1: Failing unit test:**
```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, assertPasswordPolicy } from './password.js';

describe('password', () => {
  it('hash + verify round-trips and rejects wrong password', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(await verifyPassword(h, 'correct-horse-battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
  it('assertPasswordPolicy rejects < 12 chars', () => {
    expect(() => assertPasswordPolicy('short')).toThrow();
    expect(assertPasswordPolicy('twelve-chars-ok')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/auth/password.ts`:**
```ts
import argon2 from 'argon2';

export function assertPasswordPolicy(pw: string): void {
  if (typeof pw !== 'string' || pw.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
}

export function hashPassword(pw: string): Promise<string> {
  assertPasswordPolicy(pw);
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
}

export function verifyPassword(hash: string, pw: string): Promise<boolean> {
  return argon2.verify(hash, pw).catch(() => false);
}
```

- [ ] **Step 4: Run → pass** `npx vitest run src/auth/password.test.ts`.
- [ ] **Step 5: Commit** `git add src/auth/password.ts src/auth/password.test.ts && git commit -m "feat(phase6c): argon2id password hashing + policy"`.

---

## Task 7: `local-auth.ts` wrappers + re-signature `accept-invitation.ts`

**Files:** Create `src/auth/local-auth.ts`; Modify `src/auth/accept-invitation.ts`; Modify `tests/integration/auth/accept-invitation.test.ts`; Test `tests/integration/auth/local-auth.test.ts`.

- [ ] **Step 1: Re-signature `acceptInvitation` in `src/auth/accept-invitation.ts`.** Replace the function body's call + signature:
```ts
export async function acceptInvitation(
  pool: pg.Pool,
  token: string,
  passwordHash: string,
): Promise<AcceptResult> {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE app_role');
    const r = await client.query<{ status: AcceptStatus; tenant_id: string | null; user_id: string | null; role: string | null }>(
      'SELECT * FROM accept_invitation($1, $2)', [token, passwordHash]);
    const row = r.rows[0];
    if (!row) throw new Error('accept_invitation returned no row');
    if (row.status === 'accepted') return { status: 'accepted', tenantId: row.tenant_id!, userId: row.user_id!, role: row.role as Role };
    return { status: row.status };
  } finally {
    client.release();
  }
}
```
Update `AcceptStatus` to `'accepted' | 'invalid_token' | 'already_accepted' | 'expired' | 'email_taken'` (drop `email_mismatch`/`already_member`). Keep `emailHasUser` unchanged.

- [ ] **Step 2: Update `accept-invitation.test.ts`** — its `beforeAll` seeds via `resolve_or_provision_tenant`; switch to `seedTenantOwner`. Change the `acceptInvitation(pool, token, subject, email)` calls to `acceptInvitation(pool, token, 'some-hash')`; assert the created user's email/role come from the invite; replace the `email_mismatch` case with an `email_taken` case (invite an email that already belongs to a user).

- [ ] **Step 3: Write failing test** `tests/integration/auth/local-auth.test.ts` for the new wrappers (`signup`, `findUserByEmail`, `consumePasswordReset`):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { signup, findUserByEmail, consumePasswordReset } from '../../../src/auth/local-auth.js';

describe('local-auth wrappers', () => {
  let fixture: PgFixture; let pool: pg.Pool;
  beforeAll(async () => { fixture = await startPostgres(); pool = (await migratedDb(fixture.url)).pool; }, 120_000);
  afterAll(async () => { await pool?.end(); await fixture?.stop(); });

  it('signup creates a tenant+owner; duplicate → email_taken', async () => {
    const a = await signup(pool, 'la@example.com', 'hashA');
    expect(a.status).toBe('created');
    expect((await signup(pool, 'la@example.com', 'hashB')).status).toBe('email_taken');
  });
  it('findUserByEmail returns the row+hash', async () => {
    await signup(pool, 'finder@example.com', 'theHash');
    const u = await findUserByEmail(pool, 'finder@example.com');
    expect(u?.role).toBe('owner'); expect(u?.passwordHash).toBe('theHash');
    expect(await findUserByEmail(pool, 'nobody@example.com')).toBeNull();
  });
  it('consumePasswordReset sets the new hash', async () => {
    const s = await signup(pool, 'reset@example.com', 'origHash');
    await runAsTenant(pool, s.status === 'created' ? s.tenantId : '', async (c) => { await c.query(
      `INSERT INTO password_resets (tenant_id,user_id,token,expires_at) VALUES ($1,$2,'la-tok', now()+interval '1 hour')`,
      [s.status === 'created' ? s.tenantId : '', s.status === 'created' ? s.userId : '']); });
    const r = await consumePasswordReset(pool, 'la-tok', 'newHash');
    expect(r.status).toBe('ok');
  });
});
```

- [ ] **Step 4: Run → fail.**

- [ ] **Step 5: Create `src/auth/local-auth.ts`:**
```ts
import type pg from 'pg';
import type { Role } from './roles.js';

export type SignupResult =
  | { status: 'created'; tenantId: string; userId: string; role: Role }
  | { status: 'email_taken' };

export async function signup(pool: pg.Pool, email: string, passwordHash: string): Promise<SignupResult> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ status: string; tenant_id: string | null; user_id: string | null; role: string | null }>(
      'SELECT * FROM signup_tenant($1, $2)', [email, passwordHash]);
    const row = r.rows[0]!;
    if (row.status === 'created') return { status: 'created', tenantId: row.tenant_id!, userId: row.user_id!, role: row.role as Role };
    return { status: 'email_taken' };
  } finally { c.release(); }
}

export interface FoundUser { userId: string; tenantId: string; role: Role; passwordHash: string | null; }

export async function findUserByEmail(pool: pg.Pool, email: string): Promise<FoundUser | null> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ user_id: string; tenant_id: string; role: string; password_hash: string | null }>(
      'SELECT * FROM find_user_by_email($1)', [email]);
    const row = r.rows[0];
    if (!row) return null;
    return { userId: row.user_id, tenantId: row.tenant_id, role: row.role as Role, passwordHash: row.password_hash };
  } finally { c.release(); }
}

export type ConsumeResetResult = { status: 'ok'; userId: string } | { status: 'invalid_token' | 'expired' | 'already_used' };

export async function consumePasswordReset(pool: pg.Pool, token: string, passwordHash: string): Promise<ConsumeResetResult> {
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ status: string; user_id: string | null }>(
      'SELECT * FROM consume_password_reset($1, $2)', [token, passwordHash]);
    const row = r.rows[0]!;
    if (row.status === 'ok') return { status: 'ok', userId: row.user_id! };
    return { status: row.status as 'invalid_token' | 'expired' | 'already_used' };
  } finally { c.release(); }
}
```
(`acceptInvitation` stays in `accept-invitation.ts`.)

- [ ] **Step 6: Run → pass** both `local-auth.test.ts` and `accept-invitation.test.ts`. `npm run typecheck` will still be red in `accept.ts`/`server.ts` (old callers) — expected.

- [ ] **Step 7: Commit (`--no-verify`)**
```bash
git add src/auth/local-auth.ts src/auth/accept-invitation.ts tests/integration/auth/local-auth.test.ts tests/integration/auth/accept-invitation.test.ts
git commit --no-verify -m "feat(phase6c): local-auth wrappers + accept-invitation re-signature"
```

---

## Task 8: Remove WorkOS from identity + delete dead modules + config

**Files:** Modify `src/auth/identity.ts`, `src/auth/identity.test.ts`, `src/config.ts`, `.env.example`, `package.json`; Delete `src/auth/oauth/workos.ts`, `src/auth/oauth/workos.test.ts`, `src/auth/tenant-resolver.ts`.

- [ ] **Step 1: Update `identity.ts`** — remove `verifier`/`resolveTenant` from `IdentityResolverConfig` and delete the `if (config.verifier && config.resolveTenant) { ... }` block entirely. The resolver becomes: `if (!header) return null; … if (token === devToken) return devPrincipal; if (token.startsWith('op_live_')) return apiKeyResolver?.(token) ?? null; return null;`. Remove the `AccessTokenVerifier`/`TenantResolver` imports.

- [ ] **Step 2: Update `identity.test.ts`** — delete the OAuth-path tests (verifier/pending_invite). Keep dev-token + api-key + no-token(401) tests.

- [ ] **Step 3: Delete dead modules:**
```bash
git rm src/auth/oauth/workos.ts src/auth/oauth/workos.test.ts src/auth/tenant-resolver.ts
```

- [ ] **Step 4: `src/config.ts`** — remove `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_AUTHKIT_DOMAIN`, `WORKOS_JWKS_URI`, `WORKOS_ISSUER` from the zod schema and the returned object (`workosClientId`, `workosApiKey`, `workosAuthkitDomain`, `workosJwksUri`, `workosIssuer`).

- [ ] **Step 5: `.env.example`** — delete the `WORKOS_*` lines.

- [ ] **Step 6: `package.json`** — remove `"@workos-inc/node"` from `dependencies`; run `npm install` to update the lockfile.

- [ ] **Step 7: Run unit tests + check.** `npx vitest run src/auth/` (identity + password + roles + api-key green). `npm run typecheck` will still be red ONLY in `src/server.ts` + `src/dashboard/server.ts` + `src/dashboard/routes/accept.ts` (old WorkOS/resolver/accept callers) — fixed in Tasks 9–12. Confirm no OTHER files newly error.

- [ ] **Step 8: Commit (`--no-verify`)**
```bash
git add src/auth/identity.ts src/auth/identity.test.ts src/config.ts .env.example package.json package-lock.json
git rm src/auth/oauth/workos.ts src/auth/oauth/workos.test.ts src/auth/tenant-resolver.ts
git commit --no-verify -m "feat(phase6c): drop WorkOS from identity/config; delete dead auth modules"
```

---

## Task 9: Dashboard server — local signup/login/logout + views

**Files:** Modify `src/dashboard/server.ts`, `src/dashboard/session.ts`, `src/dashboard/views/login.eta`; Create `src/dashboard/views/signup.eta`; Test `tests/integration/dashboard/local-auth-pages.test.ts`.

- [ ] **Step 1: `session.ts`** — remove the optional `pending` field from `DashboardSession` and the `pending` branches in `requireSession`/`requireRole` (no pre-tenant sessions anymore). Keep the legacy-cookie role validation.

- [ ] **Step 2: Rewrite `DashboardDeps` + routes in `src/dashboard/server.ts`.** New deps:
```ts
import type { Role } from '../auth/roles.js';
export interface DashboardDeps {
  cookieSecret: string;
  signup: (email: string, password: string) =>
    Promise<{ status: 'created'; tenantId: string; userId: string; role: Role; email: string } | { status: 'email_taken' } | { status: 'invalid_password' }>;
  login: (email: string, password: string) =>
    Promise<{ ok: true; tenantId: string; userId: string; role: Role; email: string } | { ok: false }>;
  registerPages: (app: FastifyInstance) => void;
}
```
Replace the `/dashboard/login` redirect + `/dashboard/login/callback` with:
- `GET /dashboard/login` → `reply.view('login', { error: null })`.
- `POST /dashboard/login` → `const { email, password } = req.body; const r = await deps.login(email, password); if (!r.ok) return reply.code(401).view('login', { error: 'Invalid email or password' }); setSession(reply, { tenantId: r.tenantId, userId: r.userId, subject: r.email, role: r.role, email: r.email }); return reply.redirect('/dashboard');`
- `GET /dashboard/signup` → `reply.view('signup', { error: null })`.
- `POST /dashboard/signup` → `deps.signup(...)`; on `email_taken` → re-render with "That email is already in use"; on `invalid_password` → "Password must be at least 12 characters"; on `created` → `setSession(...)` → `/dashboard`.
- `POST /dashboard/logout` — unchanged.
Remove the `TenantResolution` import and all WorkOS code. Apply `@fastify/rate-limit` (already registered globally for /mcp? confirm — if it's route-scoped, add a `config.rateLimit` to the login POST; otherwise add a small per-route limit). Keep the eta/cookie/formbody/static registration.

- [ ] **Step 3: Rewrite `login.eta`** as an email+password form (POST `/dashboard/login`, fields `email`,`password`, an error slot, and a link to `/dashboard/signup`). Create `signup.eta` (POST `/dashboard/signup`, `email`,`password`, error slot, link to login). Plain server-rendered forms (no CSRF needed pre-session; these establish the session). Match the existing `login.eta` card styling.

- [ ] **Step 4: Integration test** `tests/integration/dashboard/local-auth-pages.test.ts` — boot Fastify + `registerDashboard` with real `signup`/`login` wrappers built from a `migratedDb` pool (wrap `signup`/`findUserByEmail`+`verifyPassword`); assert: signup creates session + redirects to /dashboard; duplicate signup → error; login with right/wrong password (200 redirect vs 401); short password → policy error. Use `app.inject`, parse Set-Cookie. (Model on `pages-manage.test.ts` for the Fastify+inject pattern.)

- [ ] **Step 5: Run → pass** the new test. `npm run typecheck` still red only in `server.ts` + `accept.ts` (Tasks 11/12).

- [ ] **Step 6: Commit (`--no-verify`)**
```bash
git add src/dashboard/server.ts src/dashboard/session.ts src/dashboard/views/login.eta src/dashboard/views/signup.eta tests/integration/dashboard/local-auth-pages.test.ts
git commit --no-verify -m "feat(phase6c): dashboard local signup/login + views"
```

---

## Task 10: Accept / reset / change-password routes + views

**Files:** Rewrite `src/dashboard/routes/accept.ts`; Create `src/dashboard/routes/auth.ts` (reset + change-password); Create `src/dashboard/views/reset.eta`; Modify `src/dashboard/views/accept.eta`; Test `tests/integration/dashboard/auth-routes.test.ts`.

- [ ] **Step 1: Rewrite `accept.ts`** — now PUBLIC (no `requireSession`): `GET /dashboard/accept?token=` → `reply.view('accept', { token, error: null })` (form: hidden token + a `password` field). `POST /dashboard/accept` → `{ token, password }`; `assertPasswordPolicy` (catch → re-render policy error); `const hash = await hashPassword(password); const r = await acceptInvitation(deps.pool, token, hash);` on `accepted` → `setSession({ tenantId, userId, subject: <invite email — return it from acceptInvitation? no; look up via findUserByEmail or include email in AcceptResult>, role, email })` → `/dashboard`; else friendly message. NOTE: `AcceptResult` doesn't carry the email; add `email` to the `accepted` variant (return `v_inv.email` from the SQL function and thread it through `acceptInvitation`). Update the SQL `accept_invitation` RETURNS to include `email text` and the wrapper's `AcceptResult.accepted` to include `email`. (Adjust Task 4's function + Task 7's wrapper accordingly — or, simpler, do a `findUserByEmail` after accept using the userId... but findUserByEmail is by email. Cleanest: add `email` to the function's RETURNS + wrapper.)

  Deps: `registerAccept(app, { pool })` uses `acceptInvitation` + `hashPassword`.

- [ ] **Step 2: `auth.ts`** — `registerAuthRoutes(app, { pool })`:
  - `GET /dashboard/reset?token=` → `reply.view('reset', { token, error: null })`.
  - `POST /dashboard/reset` → `{ token, password }`; policy check; `const r = await consumePasswordReset(pool, token, await hashPassword(password));` on `ok` → redirect `/dashboard/login` (with a notice); else friendly error.
  - `POST /dashboard/account/password` (`requireSession` + CSRF) → `{ current, next }`; load the user's hash under tenant RLS, `verifyPassword(hash, current)` (else 400), `assertPasswordPolicy(next)`, `UPDATE users SET password_hash=$ WHERE id=session.userId` under `withTenantConn`.

- [ ] **Step 3: Views** — `accept.eta` add a `password` field (set-your-password); `reset.eta` similar. Both plain forms (token in a hidden field; no session yet so no CSRF on accept/reset — token possession is the auth). The change-password form lives on an account/settings page or the overview — add a minimal form (CSRF'd) to `overview.eta` or a new `account.eta`; keep it minimal.

- [ ] **Step 4: Integration test** `auth-routes.test.ts` — invite (insert invitations row) → GET/POST accept sets password + session; admin-created `password_resets` row → POST reset → login with new password; change-password happy + wrong-current. Model on existing dashboard tests.

- [ ] **Step 5: Run → pass.** typecheck still red in `server.ts` (Task 12).

- [ ] **Step 6: Commit (`--no-verify`)**
```bash
git add src/dashboard/routes/accept.ts src/dashboard/routes/auth.ts src/dashboard/views/reset.eta src/dashboard/views/accept.eta src/dashboard/views/overview.eta tests/integration/dashboard/auth-routes.test.ts
git commit --no-verify -m "feat(phase6c): accept(set-password) + reset + change-password routes"
```

---

## Task 11: Users/Team — "Reset password" action

**Files:** Modify `src/dashboard/routes/users.ts`, `src/dashboard/views/users.eta`; Test `tests/integration/dashboard/users.test.ts` (add a case).

- [ ] **Step 1: Add failing test** (append to `users.test.ts`, which seeds an owner — switch its `beforeAll` seeding to `seedTenantOwner` and sessions to that tenant): owner posts `/dashboard/users/:id/reset` (CSRF) for a seeded member → 200, body contains `/dashboard/reset?token=`, and a `password_resets` row exists for that user.

- [ ] **Step 2: Run → fail** (route 404).

- [ ] **Step 3: Add the handler** to `users.ts` (gated `requireRole('owner','admin')`, CSRF):
```ts
app.post('/dashboard/users/:id/reset', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
  if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
  const session = (req as typeof req & { session: DashboardSession }).session;
  const { id } = req.params as { id: string };
  const token = randomBytes(32).toString('base64url');
  let link: string | null = null;
  const outcome = await withTenantConn(deps.pool, session.tenantId, async (client) => {
    const t = await client.query(`SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2 AND status<>'deleted'`, [id, session.tenantId]);
    if (t.rowCount === 0) return 404 as const;
    await client.query(
      `INSERT INTO password_resets (tenant_id, user_id, token, expires_at) VALUES ($1,$2,$3, now()+interval '1 hour')`,
      [session.tenantId, id, token]);
    return 200 as const;
  });
  if (outcome === 404) return reply.code(404).send('User not found');
  link = `/dashboard/reset?token=${token}`;
  const { members, invites } = await loadPage(deps.pool, session.tenantId);
  return reply.view('users', { csrf: session.csrf, actorRole: session.role, actorUserId: session.userId, members, invites, newInviteLink: null, resetLink: link, error: null });
});
```
Add `resetLink` to the other `reply.view('users', …)` calls (default `null`), import `randomBytes`.

- [ ] **Step 4: `users.eta`** — add a "Reset password" button per member row (CSRF form → `/dashboard/users/<id>/reset`), and a one-time banner showing `it.resetLink` when present (mirror the invite-link banner).

- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit (`--no-verify` if server.ts still red)** `git add src/dashboard/routes/users.ts src/dashboard/views/users.eta tests/integration/dashboard/users.test.ts && git commit --no-verify -m "feat(phase6c): owner/admin password-reset links"`.

---

## Task 12: Wire `src/server.ts` + make the whole project green

**Files:** Modify `src/server.ts`; fix all remaining test stubs.

- [ ] **Step 1: Rewrite the WorkOS wiring in `src/server.ts`.**
  - Remove the `WorkOS` import + client, `createWorkOsVerifier`/`createTenantResolver` imports + `verifier`/`resolveTenant` consts, and the `oauth: {...}` block + `verifier`/`resolveTenant` from the `createMcpServer({...})` config.
  - Build local-auth deps and pass to `registerDashboard`:
```ts
import { signup as signupFn, findUserByEmail } from './auth/local-auth.js';
import { hashPassword, verifyPassword, assertPasswordPolicy } from './auth/password.js';
// ...
await registerDashboard(app, {
  cookieSecret: cfg.dashboardCookieSecret,
  signup: async (email, password) => {
    try { assertPasswordPolicy(password); } catch { return { status: 'invalid_password' as const }; }
    const r = await signupFn(pool, email, await hashPassword(password));
    return r.status === 'created'
      ? { status: 'created' as const, tenantId: r.tenantId, userId: r.userId, role: r.role, email }
      : { status: 'email_taken' as const };
  },
  login: async (email, password) => {
    const u = await findUserByEmail(pool, email);
    if (!u || !u.passwordHash || !(await verifyPassword(u.passwordHash, password))) return { ok: false as const };
    return { ok: true as const, tenantId: u.tenantId, userId: u.userId, role: u.role, email };
  },
  registerPages: (pageApp) => {
    registerOverview(pageApp, { pool });
    registerOpenprovider(pageApp, { pool, kms, kmsKeyName: cfg.gcpKmsKeyName });
    registerPolicy(pageApp, { pool });
    registerKeys(pageApp, { pool });
    registerAudit(pageApp, { pool });
    registerConfirmations(pageApp, { pool, kms, kmsKeyName: cfg.gcpKmsKeyName, openproviderClient });
    registerUsers(pageApp, { pool });
    registerAccept(pageApp, { pool });
    registerAuthRoutes(pageApp, { pool });
  },
});
```
  Add `import { registerAuthRoutes } from './dashboard/routes/auth.js';`.

- [ ] **Step 2: Fix remaining integration/e2e test stubs** that referenced WorkOS/`resolveTenant`/`resolve_or_provision_tenant`:
  - `pages-manage.test.ts`, `pages-core.test.ts` — their `registerDashboard({...})` calls pass `buildAuthorizationUrl`/`authenticateWithCode`/`resolveTenant`; replace with the new `{ signup, login }` deps (stub `signup`/`login` returning fixed tenant/user/role, or build them from the pool). Seeds via `resolve_or_provision_tenant` → `seedTenantOwner`.
  - `dashboard-key-e2e.test.ts`, `rbac-e2e.test.ts`, `e2e.test.ts` — replace `resolve_or_provision_tenant` seeding with `seedTenantOwner`; remove any WorkOS `verifier`/`resolveTenant` from their `createMcpServer` configs (rbac-e2e used a fake verifier — switch it to authenticate via API keys, or seed users + issue keys; update the scenario to use `op_live_` keys instead of bearer tokens).
  - Any `makeSession` lacking `role` already fixed in 6b; ensure no `pending` references remain.

- [ ] **Step 3: Full green gate:**
  - `npm run typecheck` → 0 errors.
  - `npm run lint` → 0 warnings.
  - `npx vitest run` (unit) → green.
  - `npx vitest run --config vitest.integration.config.ts` (all integration) → green (3 live tests skipped).

- [ ] **Step 4: Commit (normal — should pass husky now)**
```bash
git add -A
git commit -m "feat(phase6c): wire local auth into server; remove WorkOS; fix test stubs"
```

---

## Task 13: E2E — local-auth + RBAC loop

**Files:** Create `tests/integration/mcp/local-auth-e2e.test.ts`.

- [ ] **Step 1: Write the e2e** (real HTTP). Boot `createMcpServer` + `registerDashboard` (local deps) on a real port. Scenario:
  1. `POST /dashboard/signup` (owner email+password) → 302 + session cookie; owner provisioned.
  2. Owner issues an API key via `POST /dashboard/keys/issue` (CSRF) → extract `op_live_…`.
  3. Owner invites an operator via `POST /dashboard/users/invite` → extract the `/dashboard/accept?token=` link.
  4. `POST /dashboard/accept` (token + password) → operator user created + session.
  5. Operator logs in via `POST /dashboard/login` → 302.
  6. Issue an operator-scoped API key (owner issues, or operator issues their own) → call `/mcp` `register_domain` with it → confirmation_required; operator `confirm_pending` → `approver_role_required`; owner-scoped key... (owner approval is via the dashboard confirmations page or an owner principal). Assert the operator is blocked from approving. (Reuse the rbac-e2e dispatch wiring; the only change is identities come from local signup/accept, not WorkOS.)
  Model the MCP dispatch wiring on `tests/integration/mcp/rbac-e2e.test.ts`.

- [ ] **Step 2: Run → pass** `npx vitest run --config vitest.integration.config.ts tests/integration/mcp/local-auth-e2e.test.ts` (be patient with boot).

- [ ] **Step 3: Commit** `git add tests/integration/mcp/local-auth-e2e.test.ts && git commit -m "test(phase6c): e2e local signup→invite→accept→RBAC"`.

---

## Task 14: Full suite + docs + STOP

**Files:** Modify `README.md`, `CHANGELOG.md`.

- [ ] **Step 1: Full gate** `npm run typecheck && npm run lint && npm test && npm run test:integration` — all green (Docker up; 3 live tests skipped). Fix any regression before proceeding.
- [ ] **Step 2: README** — replace the WorkOS/AuthKit auth section with the local email+password flow (signup → tenant+owner; invite-accept-sets-password; admin reset links; change-password; `/mcp` = API keys only). Note `WORKOS_*` env vars are gone; `DASHBOARD_COOKIE_SECRET` + `DEV_BEARER_TOKEN` remain.
- [ ] **Step 3: CHANGELOG** — new `0.10.0-phase6c` entry: local email+password auth replaces WorkOS (migration 0013; `signup_tenant`/`find_user_by_email`/`accept_invitation(token,hash)`/`consume_password_reset`); dashboard signup/login/accept-set-password/reset/change-password; `@workos-inc/node` + `WORKOS_*` removed; `/mcp` API-key-only.
- [ ] **Step 4: Commit** `git add README.md CHANGELOG.md && git commit -m "docs(phase6c): README + CHANGELOG for local auth"`.
- [ ] **Step 5: STOP — do not push.** Report to the user for a single review + push approval for the whole phase.

---

## Self-Review

**1. Spec coverage:** §2 schema → Task 1; `signup_tenant` → Task 2; `find_user_by_email` → Task 3; `accept_invitation` re-sig → Task 4; `consume_password_reset` → Task 5; `password.ts` → Task 6; `local-auth.ts` → Task 7; identity/WorkOS removal + config + dep → Task 8; dashboard signup/login + views → Task 9; accept/reset/change-password → Task 10; Users reset action → Task 11; server wiring + green → Task 12; e2e → Task 13; docs/STOP → Task 14. All §-items covered. ✅

**2. Placeholder scan:** No TBD/TODO. The widespread test-seeding switch is given as a concrete recipe (`seedTenantOwner` + per-file replacement of `resolve_or_provision_tenant`/WorkOS stubs) — mechanical, not a placeholder. Task 10 flags a real dependency (the invite email must flow into the session) and resolves it by adding `email` to `accept_invitation`'s RETURNS + the `AcceptResult.accepted` variant — **this also amends Task 4's function (add `email text` to RETURNS) and Task 7's wrapper; the implementer must apply that when reaching Task 10, or fold it into Task 4.** (Recommend folding the `email` column into Task 4 up front.)

**3. Type consistency:** `Role` from `roles.js` throughout. `signup`/`findUserByEmail`/`consumePasswordReset`/`acceptInvitation` signatures match between `local-auth.ts`/`accept-invitation.ts` (Task 7) and `server.ts` wiring (Task 12) and the dashboard deps (Task 9). `AcceptResult.accepted` gains `email` (Tasks 4/7/10). Status string unions match the SQL function returns. ✅

**Fold-forward note for the executor:** apply the `accept_invitation` `email` addition in **Task 4** (RETURNS `(status, tenant_id, user_id, role, email)`; wrapper returns it) so Task 10 doesn't retrofit it.

*End of plan.*

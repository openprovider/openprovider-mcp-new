# Phase 6b — Multi-User Invitation + RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let owners/admins invite teammates by token'd link into their existing tenant, with explicit accept and full owner/admin/operator/viewer RBAC enforced across the dashboard.

**Architecture:** A new `invitations` table (migration 0012) plus three SECURITY DEFINER functions confine all cross-tenant reads/writes: `resolve_or_provision_tenant` gains a `pending_invite` branch, `accept_invitation` atomically joins an invitee into the inviting tenant, and `email_has_user` guards duplicate invites. The dashboard session carries the user's role; a `requireRole` preHandler gates the management pages. The MCP/tool side already enforces RBAC via the per-user `role` on the `Principal` and the confirmation `required_approver_roles` check — Phase 6b adds an end-to-end test proving the cross-user propose→approve loop, no MCP code change.

**Tech Stack:** PostgreSQL 16 (RLS + SECURITY DEFINER plpgsql), Drizzle (raw-SQL migrations + schema mirror), `pg`, Fastify 5 + `@fastify/cookie`/`@fastify/formbody`/`@fastify/view` + eta + htmx, Vitest + testcontainers (Postgres) + Nock, argon2 (existing).

**Spec:** `docs/superpowers/specs/2026-05-27-phase6b-rbac-design.md`

**Branch:** `feat/enterprise-phase-1` (stacks on Phases 1–7).

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `migrations/0012_invitations.sql` | new | `invitations` table + RLS + indexes; DROP/CREATE `resolve_or_provision_tenant` (adds `status`, `pending_invite` branch); new `accept_invitation`; new `email_has_user`. |
| `migrations/meta/_journal.json` | mod | append journal entry `idx: 11`, tag `0012_invitations`. |
| `src/db/schema.ts` | mod | add `invitations` Drizzle mirror. |
| `src/auth/roles.ts` | new | shared `Role` type + `ROLES` constant. |
| `src/auth/tenant-resolver.ts` | mod | `TenantResolution` becomes a discriminated union with `status`. |
| `src/auth/identity.ts` | mod | MCP path returns `null` (401) on `pending_invite`. |
| `src/auth/accept-invitation.ts` | new | `acceptInvitation()` + `emailHasUser()` pool wrappers over the definer functions. |
| `src/dashboard/user-admin.ts` | new | pure RBAC helpers: `canManage`, `canAssignRole`, `wouldOrphanOwners`. |
| `src/dashboard/session.ts` | mod | `DashboardSession` gains `role` + optional `pending`/`email`; new `requireRole(...allowed)` preHandler; pending-guard in `requireSession`. |
| `src/dashboard/server.ts` | mod | `DashboardDeps.resolveTenant` returns `status`; login callback routes `pending_invite` → `/dashboard/accept`. |
| `src/dashboard/routes/accept.ts` | new | `GET`/`POST /dashboard/accept`. |
| `src/dashboard/routes/users.ts` | new | Users/Team page: list, invite, change-role, remove, revoke-invite. |
| `src/dashboard/routes/{openprovider,policy,keys,confirmations}.ts` | mod | add `requireRole` gates per the RBAC matrix. |
| `src/dashboard/views/accept.eta` | new | accept page. |
| `src/dashboard/views/users.eta` | new | Users/Team page. |
| `src/dashboard/views/layout.eta` | mod | add "Team" nav link. |
| `tests/integration/auth/invitations.test.ts` | new | `resolve` pending_invite branch, `accept_invitation`, `email_has_user`. |
| `tests/integration/auth/accept-invitation.test.ts` | new | TS wrapper integration (accept + emailHasUser). |
| `tests/integration/dashboard/users.test.ts` | new | Users page + accept routes + RBAC gates. |
| `tests/integration/mcp/rbac-e2e.test.ts` | new | two-user operator-proposes/owner-approves. |
| `src/auth/roles.test.ts`, `src/dashboard/user-admin.test.ts`, `src/dashboard/session.test.ts` (mod) | new/mod | unit tests. |

**Commands** (from repo root): unit+integration `npm test`; single file `npx vitest run <path>`; typecheck `npm run typecheck`; lint `npm run lint`. Integration tests need Docker running.

---

## Task 1: Migration 0012 — `invitations` table + schema mirror

**Files:**
- Create: `migrations/0012_invitations.sql`
- Modify: `migrations/meta/_journal.json`
- Modify: `src/db/schema.ts`
- Test: `tests/integration/auth/invitations.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/integration/auth/invitations.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';

describe('migration 0012 invitations', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['inv_owner_sub', 'owner@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('inserts a pending invite scoped to the tenant under RLS', async () => {
    const id = await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'invitee@example.com', 'operator', 'tok-1', now() + interval '7 days')
         RETURNING id`,
        [tenantId],
      );
      return r.rows[0]!.id;
    });
    expect(id).toBeTruthy();
  });

  it('enforces the partial unique index: two pending invites for one email collide', async () => {
    await expect(
      runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
           VALUES ($1, 'invitee@example.com', 'viewer', 'tok-2', now() + interval '7 days')`,
          [tenantId],
        );
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('rejects role=owner via the CHECK constraint', async () => {
    await expect(
      runAsTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
           VALUES ($1, 'owner2@example.com', 'owner', 'tok-3', now() + interval '7 days')`,
          [tenantId],
        );
      }),
    ).rejects.toThrow(/check|constraint/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: FAIL — `relation "invitations" does not exist`.

- [ ] **Step 3: Create the migration file** (`migrations/0012_invitations.sql`)

```sql
CREATE TABLE invitations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  email              text NOT NULL,
  role               text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  token              text NOT NULL,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  accepted_at        timestamptz
);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY invitations_isolation ON invitations
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO app_role;

CREATE UNIQUE INDEX invitations_pending_email ON invitations (tenant_id, email) WHERE accepted_at IS NULL;
CREATE UNIQUE INDEX invitations_token ON invitations (token);
```

- [ ] **Step 4: Append the journal entry** — in `migrations/meta/_journal.json`, add as the last element of `entries` (note the comma after the previous `0011` entry):

```json
    { "idx": 11, "version": "5", "when": 1748700000000, "tag": "0012_invitations", "breakpoints": true }
```

- [ ] **Step 5: Add the Drizzle mirror** — append to `src/db/schema.ts` (after the `auditArchives` block):

```ts
export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  email: text('email').notNull(),
  role: text('role').notNull(),
  token: text('token').notNull(),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
});
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: the 3 tests in this file PASS. (The `resolve_or_provision_tenant` SELECT still works because the current function returns `tenant_id` among its columns.)

- [ ] **Step 7: Commit**

```bash
git add migrations/0012_invitations.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/auth/invitations.test.ts
git commit -m "feat(phase6b): invitations table (migration 0012) + schema mirror"
```

---

## Task 2: Replace `resolve_or_provision_tenant` with the `pending_invite` branch

**Files:**
- Modify: `migrations/0012_invitations.sql` (append)
- Test: `tests/integration/auth/invitations.test.ts` (add cases)

- [ ] **Step 1: Add failing tests** — append inside the `describe` block in `tests/integration/auth/invitations.test.ts`:

```ts
  async function resolve(subject: string, email: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ status: string; tenant_id: string | null; role: string | null }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        [subject, email],
      );
      return r.rows[0]!;
    } finally {
      c.release();
    }
  }

  it('resolve returns status=resolved + role=owner when provisioning a brand-new subject', async () => {
    const res = await resolve('inv_fresh_sub', 'fresh@example.com');
    expect(res.status).toBe('resolved');
    expect(res.tenant_id).toBeTruthy();
    expect(res.role).toBe('owner');
  });

  it('resolve returns pending_invite (no provision) when a pending invite matches the email', async () => {
    // tenantId already has a pending invite for invitee@example.com (Task 1 Step 1).
    const res = await resolve('invitee_new_sub', 'invitee@example.com');
    expect(res.status).toBe('pending_invite');
    expect(res.tenant_id).toBeNull();

    // No tenant was provisioned for this subject.
    const c = await pool.connect();
    try {
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE oauth_subject = $1`,
        ['invitee_new_sub'],
      );
      expect(r.rows[0]!.count).toBe('0');
    } finally {
      c.release();
    }
  });

  it('resolve still resolves an existing user even if a pending invite exists for their email', async () => {
    // The owner already has a user row; the pending-invite email differs, but prove branch-1 wins.
    const res = await resolve('inv_owner_sub', 'owner@example.com');
    expect(res.status).toBe('resolved');
    expect(res.role).toBe('owner');
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: FAIL — `res.status` is `undefined` (current function has no `status` column).

- [ ] **Step 3: Append the function replacement** to `migrations/0012_invitations.sql`:

```sql
DROP FUNCTION IF EXISTS resolve_or_provision_tenant(text, text);

CREATE FUNCTION resolve_or_provision_tenant(p_subject text, p_email text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_new_tenant_id uuid;
BEGIN
  LOOP
    -- Branch 1: existing user resolves to their tenant.
    RETURN QUERY
      SELECT 'resolved'::text, u.tenant_id, u.id, u.role FROM users u WHERE u.oauth_subject = p_subject;
    IF FOUND THEN
      RETURN;
    END IF;

    -- Branch 2: a pending, non-expired invite for this email → signal accept, do NOT provision.
    IF EXISTS (
      SELECT 1 FROM invitations i
       WHERE lower(i.email) = lower(p_email)
         AND i.accepted_at IS NULL
         AND i.expires_at > now()
    ) THEN
      RETURN QUERY SELECT 'pending_invite'::text, NULL::uuid, NULL::uuid, NULL::text;
      RETURN;
    END IF;

    -- Branch 3: provision a fresh tenant + owner user.
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
        RETURNING 'resolved'::text, users.tenant_id, users.id, users.role;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- lost the race; subtransaction (incl. tenants + policies) rolled back. Loop.
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION resolve_or_provision_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_provision_tenant(text, text) TO app_role;
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Confirm the existing resolver test still passes** (it reads `tenant_id`/`user_id`/`role`, ignores `status`):

Run: `npx vitest run tests/integration/auth/resolve-provision.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0012_invitations.sql tests/integration/auth/invitations.test.ts
git commit -m "feat(phase6b): resolve_or_provision_tenant pending_invite branch"
```

---

## Task 3: `accept_invitation` SECURITY DEFINER function

**Files:**
- Modify: `migrations/0012_invitations.sql` (append)
- Test: `tests/integration/auth/invitations.test.ts` (add cases)

- [ ] **Step 1: Add failing tests** — append inside the `describe` block:

```ts
  async function accept(token: string, subject: string, email: string) {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ status: string; tenant_id: string | null; role: string | null }>(
        'SELECT * FROM accept_invitation($1,$2,$3)',
        [token, subject, email],
      );
      return r.rows[0]!;
    } finally {
      c.release();
    }
  }

  it('accept joins the invited tenant with the invited role (token tok-1 / invitee@example.com)', async () => {
    const res = await accept('tok-1', 'invitee_accept_sub', 'invitee@example.com');
    expect(res.status).toBe('accepted');
    expect(res.tenant_id).toBe(tenantId);
    expect(res.role).toBe('operator');
  });

  it('accept rejects a second use of the same token as already_accepted', async () => {
    const res = await accept('tok-1', 'someone_else_sub', 'invitee@example.com');
    expect(res.status).toBe('already_accepted');
  });

  it('accept rejects an unknown token', async () => {
    const res = await accept('does-not-exist', 'x_sub', 'x@example.com');
    expect(res.status).toBe('invalid_token');
  });

  it('accept rejects when the verified email does not match the invite', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'mismatch@example.com', 'viewer', 'tok-mismatch', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const res = await accept('tok-mismatch', 'mismatch_sub', 'attacker@example.com');
    expect(res.status).toBe('email_mismatch');
  });

  it('accept rejects an expired invite', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'expired@example.com', 'viewer', 'tok-expired', now() - interval '1 hour')`,
        [tenantId],
      );
    });
    const res = await accept('tok-expired', 'expired_sub', 'expired@example.com');
    expect(res.status).toBe('expired');
  });

  it('accept rejects a subject that is already a user (already_member)', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'dup@example.com', 'viewer', 'tok-dup', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const res = await accept('tok-dup', 'inv_owner_sub', 'dup@example.com');
    expect(res.status).toBe('already_member');
  });

  it('concurrent accept of one token creates exactly one user', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'race@example.com', 'viewer', 'tok-race', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const results = await Promise.all([
      accept('tok-race', 'race_sub', 'race@example.com'),
      accept('tok-race', 'race_sub', 'race@example.com'),
    ]);
    const accepted = results.filter((r) => r.status === 'accepted');
    expect(accepted).toHaveLength(1);
    const c = await pool.connect();
    try {
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE oauth_subject = 'race_sub'`,
      );
      expect(r.rows[0]!.count).toBe('1');
    } finally {
      c.release();
    }
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: FAIL — `function accept_invitation(...) does not exist`.

- [ ] **Step 3: Append the function** to `migrations/0012_invitations.sql`:

```sql
CREATE FUNCTION accept_invitation(p_token text, p_subject text, p_email text)
  RETURNS TABLE (status text, tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_inv invitations%ROWTYPE;
  v_uid uuid;
BEGIN
  -- A subject already mapped to a user belongs to exactly one tenant; reject.
  IF EXISTS (SELECT 1 FROM users u WHERE u.oauth_subject = p_subject) THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_inv FROM invitations WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_token'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF lower(v_inv.email) <> lower(p_email) THEN
    RETURN QUERY SELECT 'email_mismatch'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Atomically claim: only one concurrent caller flips accepted_at.
  UPDATE invitations SET accepted_at = now()
    WHERE id = v_inv.id AND accepted_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'already_accepted'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  INSERT INTO users (tenant_id, email, oauth_subject, role)
    VALUES (v_inv.tenant_id, NULLIF(p_email, ''), p_subject, v_inv.role)
    RETURNING id INTO v_uid;

  RETURN QUERY SELECT 'accepted'::text, v_inv.tenant_id, v_uid, v_inv.role;
END;
$$;

REVOKE ALL ON FUNCTION accept_invitation(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invitation(text, text, text) TO app_role;
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0012_invitations.sql tests/integration/auth/invitations.test.ts
git commit -m "feat(phase6b): accept_invitation SECURITY DEFINER function"
```

---

## Task 4: `email_has_user` SECURITY DEFINER function

**Files:**
- Modify: `migrations/0012_invitations.sql` (append)
- Test: `tests/integration/auth/invitations.test.ts` (add cases)

- [ ] **Step 1: Add failing tests** — append inside the `describe` block:

```ts
  async function emailHasUserSql(email: string): Promise<boolean> {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ email_has_user: boolean }>('SELECT email_has_user($1)', [email]);
      return r.rows[0]!.email_has_user;
    } finally {
      c.release();
    }
  }

  it('email_has_user is true for an existing user (cross-tenant, case-insensitive)', async () => {
    expect(await emailHasUserSql('OWNER@example.com')).toBe(true);
  });

  it('email_has_user is false for an unknown email', async () => {
    expect(await emailHasUserSql('nobody@example.com')).toBe(false);
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: FAIL — `function email_has_user(text) does not exist`.

- [ ] **Step 3: Append the function** to `migrations/0012_invitations.sql`:

```sql
CREATE FUNCTION email_has_user(p_email text)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
     WHERE lower(email) = lower(p_email) AND status <> 'deleted'
  );
$$;

REVOKE ALL ON FUNCTION email_has_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_has_user(text) TO app_role;
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/integration/auth/invitations.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0012_invitations.sql tests/integration/auth/invitations.test.ts
git commit -m "feat(phase6b): email_has_user SECURITY DEFINER guard"
```

---

## Task 5: Shared `Role` type + resolver `status` + identity pending_invite handling

**Files:**
- Create: `src/auth/roles.ts`
- Modify: `src/auth/tenant-resolver.ts`
- Modify: `src/auth/identity.ts`
- Test: `src/auth/roles.test.ts` (new), `src/auth/identity.test.ts` (add a case)

- [ ] **Step 1: Write the failing unit test** (`src/auth/roles.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from './roles.js';

describe('roles', () => {
  it('lists exactly the four roles', () => {
    expect([...ROLES].sort()).toEqual(['admin', 'operator', 'owner', 'viewer']);
  });

  it('Role type accepts the four roles (compile-time + runtime membership)', () => {
    const r: Role = 'operator';
    expect(ROLES.has(r)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/auth/roles.test.ts`
Expected: FAIL — cannot find module `./roles.js`.

- [ ] **Step 3: Create `src/auth/roles.ts`**

```ts
export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export const ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'operator', 'viewer']);
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/auth/roles.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite `src/auth/tenant-resolver.ts`** as a discriminated union carrying `status`:

```ts
import type pg from 'pg';
import type { Role } from './roles.js';

export type TenantResolution =
  | { status: 'resolved'; tenantId: string; userId: string; role: Role }
  | { status: 'pending_invite' };

export type TenantResolver = (subject: string, email: string) => Promise<TenantResolution>;

export function createTenantResolver(pool: pg.Pool): TenantResolver {
  return async (subject, email) => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE app_role');
      const r = await client.query<{
        status: string;
        tenant_id: string | null;
        user_id: string | null;
        role: string | null;
      }>('SELECT * FROM resolve_or_provision_tenant($1, $2)', [subject, email]);
      const row = r.rows[0];
      if (!row) throw new Error('resolve_or_provision_tenant returned no row');
      if (row.status === 'pending_invite') {
        return { status: 'pending_invite' };
      }
      return {
        status: 'resolved',
        tenantId: row.tenant_id!,
        userId: row.user_id!,
        role: row.role as Role,
      };
    } finally {
      client.release();
    }
  };
}
```

- [ ] **Step 6: Update `src/auth/identity.ts`** — the MCP bearer path must treat `pending_invite` as auth failure (they have no tenant until they accept in the dashboard). Replace the `if (config.verifier && config.resolveTenant) { ... }` block body (lines 30–47) with:

```ts
    if (config.verifier && config.resolveTenant) {
      let claims;
      try {
        claims = await config.verifier(token);
      } catch {
        return null; // invalid token → 401
      }
      // resolveTenant failure is a server error, not an auth failure — let it throw.
      const resolution = await config.resolveTenant(claims.subject, claims.email);
      if (resolution.status !== 'resolved') {
        return null; // pending invite not yet accepted → 401 on /mcp; accept via dashboard first
      }
      return {
        kind: 'user',
        tenantId: resolution.tenantId,
        userId: resolution.userId,
        subject: claims.subject,
        scopes: [],
        role: resolution.role,
      };
    }
```

- [ ] **Step 7: Add an identity unit test** — append to `src/auth/identity.test.ts` (mirror the existing OAuth-path test there; it uses a stub `verifier` + stub `resolveTenant`):

```ts
  it('returns null (401) when resolveTenant signals a pending invite', async () => {
    const resolve = createIdentityResolver({
      devToken: 'dev',
      devPrincipal: { kind: 'user', tenantId: 't', userId: 'u', subject: 's', scopes: [], role: 'viewer' },
      verifier: async () => ({ subject: 'sub_pending', email: 'p@example.com', expiresAt: Date.now() + 1000 }),
      resolveTenant: async () => ({ status: 'pending_invite' }),
    });
    expect(await resolve('Bearer sometoken')).toBeNull();
  });
```

(Add `import { createIdentityResolver } from './identity.js';` if the test file does not already import it — check the file header.)

- [ ] **Step 8: Run the auth unit tests + typecheck**

Run: `npx vitest run src/auth/ && npm run typecheck`
Expected: PASS. (Typecheck confirms every `resolveTenant` consumer now handles the union.)

- [ ] **Step 9: Commit**

```bash
git add src/auth/roles.ts src/auth/roles.test.ts src/auth/tenant-resolver.ts src/auth/identity.ts src/auth/identity.test.ts
git commit -m "feat(phase6b): shared Role type + resolver status union + identity pending_invite=401"
```

---

## Task 6: `accept-invitation.ts` pool wrappers

**Files:**
- Create: `src/auth/accept-invitation.ts`
- Test: `tests/integration/auth/accept-invitation.test.ts`

- [ ] **Step 1: Write the failing integration test** (`tests/integration/auth/accept-invitation.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { acceptInvitation, emailHasUser } from '../../../src/auth/accept-invitation.js';

describe('accept-invitation wrappers', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['aiw_owner', 'aiw-owner@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
    } finally {
      c.release();
    }
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'aiw-invitee@example.com', 'admin', 'aiw-tok', now() + interval '7 days')`,
        [tenantId],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('emailHasUser true for existing owner, false for unknown', async () => {
    expect(await emailHasUser(pool, 'aiw-owner@example.com')).toBe(true);
    expect(await emailHasUser(pool, 'ghost@example.com')).toBe(false);
  });

  it('acceptInvitation returns accepted + tenant + role for a valid token+email', async () => {
    const res = await acceptInvitation(pool, 'aiw-tok', 'aiw-invitee-sub', 'aiw-invitee@example.com');
    expect(res.status).toBe('accepted');
    if (res.status === 'accepted') {
      expect(res.tenantId).toBe(tenantId);
      expect(res.role).toBe('admin');
    }
  });

  it('acceptInvitation surfaces email_mismatch as a non-accepted status', async () => {
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'aiw-mm@example.com', 'viewer', 'aiw-mm-tok', now() + interval '7 days')`,
        [tenantId],
      );
    });
    const res = await acceptInvitation(pool, 'aiw-mm-tok', 'mm-sub', 'wrong@example.com');
    expect(res.status).toBe('email_mismatch');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/integration/auth/accept-invitation.test.ts`
Expected: FAIL — cannot find module `accept-invitation.js`.

- [ ] **Step 3: Create `src/auth/accept-invitation.ts`**

```ts
import type pg from 'pg';
import type { Role } from './roles.js';

export type AcceptStatus =
  | 'accepted'
  | 'invalid_token'
  | 'already_accepted'
  | 'expired'
  | 'email_mismatch'
  | 'already_member';

export type AcceptResult =
  | { status: 'accepted'; tenantId: string; userId: string; role: Role }
  | { status: Exclude<AcceptStatus, 'accepted'> };

/** Calls the accept_invitation SECURITY DEFINER function. Never throws for expected validation failures. */
export async function acceptInvitation(
  pool: pg.Pool,
  token: string,
  subject: string,
  email: string,
): Promise<AcceptResult> {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE app_role');
    const r = await client.query<{
      status: AcceptStatus;
      tenant_id: string | null;
      user_id: string | null;
      role: string | null;
    }>('SELECT * FROM accept_invitation($1,$2,$3)', [token, subject, email]);
    const row = r.rows[0];
    if (!row) throw new Error('accept_invitation returned no row');
    if (row.status === 'accepted') {
      return { status: 'accepted', tenantId: row.tenant_id!, userId: row.user_id!, role: row.role as Role };
    }
    return { status: row.status };
  } finally {
    client.release();
  }
}

/** Cross-tenant existence guard for invite creation. */
export async function emailHasUser(pool: pg.Pool, email: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE app_role');
    const r = await client.query<{ email_has_user: boolean }>('SELECT email_has_user($1)', [email]);
    return r.rows[0]!.email_has_user;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/integration/auth/accept-invitation.test.ts`
Expected: all 3 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/accept-invitation.ts tests/integration/auth/accept-invitation.test.ts
git commit -m "feat(phase6b): acceptInvitation + emailHasUser pool wrappers"
```

---

## Task 7: Pure user-admin RBAC helpers

**Files:**
- Create: `src/dashboard/user-admin.ts`
- Test: `src/dashboard/user-admin.test.ts`

- [ ] **Step 1: Write the failing unit test** (`src/dashboard/user-admin.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { canManage, canAssignRole, wouldOrphanOwners } from './user-admin.js';

describe('user-admin RBAC helpers', () => {
  it('canManage: owner can manage anyone', () => {
    expect(canManage('owner', 'owner')).toBe(true);
    expect(canManage('owner', 'admin')).toBe(true);
    expect(canManage('owner', 'viewer')).toBe(true);
  });

  it('canManage: admin can manage non-owners but not owners', () => {
    expect(canManage('admin', 'admin')).toBe(true);
    expect(canManage('admin', 'operator')).toBe(true);
    expect(canManage('admin', 'owner')).toBe(false);
  });

  it('canManage: operator/viewer can manage nobody', () => {
    expect(canManage('operator', 'viewer')).toBe(false);
    expect(canManage('viewer', 'viewer')).toBe(false);
  });

  it('canAssignRole: nobody can assign owner (ownership transfer out of scope)', () => {
    expect(canAssignRole('owner', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'owner')).toBe(false);
  });

  it('canAssignRole: owner/admin can assign non-owner roles; operator/viewer cannot', () => {
    expect(canAssignRole('owner', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'viewer')).toBe(true);
    expect(canAssignRole('operator', 'viewer')).toBe(false);
  });

  it('wouldOrphanOwners: removing the only owner orphans', () => {
    expect(wouldOrphanOwners('owner', 1, 'remove')).toBe(true);
    expect(wouldOrphanOwners('owner', 2, 'remove')).toBe(false);
    expect(wouldOrphanOwners('admin', 1, 'remove')).toBe(false);
  });

  it('wouldOrphanOwners: demoting the only owner orphans; demoting one of two does not', () => {
    expect(wouldOrphanOwners('owner', 1, { newRole: 'admin' })).toBe(true);
    expect(wouldOrphanOwners('owner', 2, { newRole: 'admin' })).toBe(false);
    expect(wouldOrphanOwners('owner', 1, { newRole: 'owner' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/dashboard/user-admin.test.ts`
Expected: FAIL — cannot find module `./user-admin.js`.

- [ ] **Step 3: Create `src/dashboard/user-admin.ts`**

```ts
import type { Role } from '../auth/roles.js';

/** Can an actor with `actorRole` change-role or remove a target with `targetRole`? */
export function canManage(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'owner';
  return false;
}

/** Can an actor assign `newRole`? Owner is never assignable (ownership transfer is out of scope). */
export function canAssignRole(actorRole: Role, newRole: Role): boolean {
  if (newRole === 'owner') return false;
  return actorRole === 'owner' || actorRole === 'admin';
}

/** Would removing / demoting this target leave the tenant with zero owners? */
export function wouldOrphanOwners(
  targetCurrentRole: Role,
  activeOwnerCount: number,
  action: 'remove' | { newRole: Role },
): boolean {
  const losesAnOwner =
    targetCurrentRole === 'owner' && (action === 'remove' || action.newRole !== 'owner');
  return losesAnOwner && activeOwnerCount <= 1;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/dashboard/user-admin.test.ts`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/user-admin.ts src/dashboard/user-admin.test.ts
git commit -m "feat(phase6b): pure user-admin RBAC helpers"
```

---

## Task 8: Session `role` + `requireRole` + pending guard

**Files:**
- Modify: `src/dashboard/session.ts`
- Test: `src/dashboard/session.test.ts` (add cases)

- [ ] **Step 1: Add failing unit tests** — append to `src/dashboard/session.test.ts`. (The file already exercises `setSession`/`readSession`/`assertCsrf` with a Fastify reply/request mock; reuse its existing helpers. These new tests use Fastify `inject` to drive the preHandler — add the imports `import Fastify from 'fastify';` and `import { sign } from '@fastify/cookie';` if absent, and `import fastifyCookie from '@fastify/cookie';`.)

```ts
import { requireRole } from './session.js';
import type { DashboardSession } from './session.js';

const RR_SECRET = 'requirerole-secret-32chars-long!!';

function rrCookie(session: DashboardSession): string {
  return `op_dash=${sign(JSON.stringify(session), RR_SECRET)}`;
}

async function rrApp() {
  const app = Fastify();
  await app.register(fastifyCookie, { secret: RR_SECRET });
  app.get('/admin', { preHandler: requireRole('owner', 'admin') }, async () => 'ok');
  await app.ready();
  return app;
}

function rrSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return { tenantId: 't', userId: 'u', subject: 's', role: 'owner', csrf: 'c', ...overrides };
}

describe('requireRole', () => {
  it('allows a role in the allowed set', async () => {
    const app = await rrApp();
    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: rrCookie(rrSession({ role: 'admin' })) } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('403s a role not in the allowed set', async () => {
    const app = await rrApp();
    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: rrCookie(rrSession({ role: 'viewer' })) } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('redirects to /dashboard/login when no session', async () => {
    const app = await rrApp();
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
    await app.close();
  });

  it('redirects a pending session to /dashboard/accept', async () => {
    const app = await rrApp();
    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: rrCookie(rrSession({ pending: true })) } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard/accept');
    await app.close();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/dashboard/session.test.ts`
Expected: FAIL — `requireRole` is not exported; type errors on `role`/`pending`.

- [ ] **Step 3: Update `src/dashboard/session.ts`** — (a) extend the interface, (b) add the pending guard to `requireSession`, (c) add `requireRole`:

Change the interface and imports at the top:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { Role } from '../auth/roles.js';

export interface DashboardSession {
  tenantId: string;
  userId: string;
  subject: string;
  role: Role;
  csrf: string;
  /** Pre-tenant marker: a logged-in invitee who has not yet accepted. */
  pending?: boolean;
  /** Verified WorkOS email — used by the accept page to list pending invites. */
  email?: string;
}
```

In `setSession`, widen the accepted shape (it already takes `Omit<DashboardSession, 'csrf'>`, which now includes `role`; no body change needed beyond the type flowing through).

Replace `requireSession` with the pending-aware version:

```ts
export function requireSession(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (e?: Error) => void,
): void {
  const s = readSession(req);
  if (!s) {
    void reply.redirect('/dashboard/login');
    return;
  }
  // A logged-in invitee who has not accepted is boxed into the accept flow.
  if (s.pending && !req.url.startsWith('/dashboard/accept')) {
    void reply.redirect('/dashboard/accept');
    return;
  }
  (req as FastifyRequest & { session?: DashboardSession }).session = s;
  done();
}
```

Append `requireRole` (a preHandler factory that also stashes the session, so it replaces `requireSession` on gated routes):

```ts
/**
 * preHandler factory: 403 when the session role is not in `allowed`.
 * Redirects unauthenticated users to login and pending invitees to accept.
 * Stashes the session on req like requireSession, so use it INSTEAD of requireSession.
 */
export function requireRole(...allowed: Role[]) {
  return function (req: FastifyRequest, reply: FastifyReply, done: (e?: Error) => void): void {
    const s = readSession(req);
    if (!s) {
      void reply.redirect('/dashboard/login');
      return;
    }
    if (s.pending) {
      void reply.redirect('/dashboard/accept');
      return;
    }
    if (!allowed.includes(s.role)) {
      void reply.code(403).send('Forbidden: insufficient role');
      return;
    }
    (req as FastifyRequest & { session?: DashboardSession }).session = s;
    done();
  };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/dashboard/session.test.ts`
Expected: all cases PASS. (Existing session tests must still pass — if any construct a `DashboardSession` literal without `role`, add `role: 'owner'` to those literals.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS — surfaces any `setSession({...})` caller missing `role` (fixed in Task 9).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/session.ts src/dashboard/session.test.ts
git commit -m "feat(phase6b): session role + requireRole preHandler + pending guard"
```

---

## Task 9: Login-callback `pending_invite` branch + accept routes

**Files:**
- Modify: `src/dashboard/server.ts`
- Create: `src/dashboard/routes/accept.ts`
- Create: `src/dashboard/views/accept.eta`
- Test: covered in Task 10's `tests/integration/dashboard/users.test.ts` (accept flow section). A minimal smoke test is added here.

- [ ] **Step 1: Update `DashboardDeps` + login callback in `src/dashboard/server.ts`.**

Change the `resolveTenant` dep type (line ~26) to return the full resolution:

```ts
import type { TenantResolution } from '../auth/tenant-resolver.js';
// ...
  /** Resolve (or provision) the tenant from WorkOS user identifiers. */
  resolveTenant: (subject: string, email: string) => Promise<TenantResolution>;
```

Replace the callback's success block (the `try { ... }` body, lines ~69–78) with the pending-aware version:

```ts
    try {
      const user = await deps.authenticateWithCode(code);
      const resolution = await deps.resolveTenant(user.subject, user.email);
      if (resolution.status === 'pending_invite') {
        // Minimal pre-tenant session: boxed into the accept flow by requireSession.
        setSession(reply, {
          tenantId: '',
          userId: '',
          subject: user.subject,
          role: 'viewer',
          pending: true,
          email: user.email,
        });
        return reply.redirect('/dashboard/accept');
      }
      setSession(reply, {
        tenantId: resolution.tenantId,
        userId: resolution.userId,
        subject: user.subject,
        role: resolution.role,
        email: user.email,
      });
      return reply.redirect('/dashboard');
    } catch (err) {
      void reply.code(400);
      const message = err instanceof Error ? err.message : 'authentication failed';
      return reply.view('login', { error: message });
    }
```

- [ ] **Step 2: Create `src/dashboard/routes/accept.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireSession, setSession, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { acceptInvitation } from '../../auth/accept-invitation.js';

const ACCEPT_MESSAGES: Record<string, string> = {
  invalid_token: 'That invitation link is not valid.',
  already_accepted: 'That invitation has already been used.',
  expired: 'That invitation has expired. Ask an owner to send a new one.',
  email_mismatch: 'This invitation was sent to a different email address.',
  already_member: 'Your account already belongs to a workspace.',
};

export function registerAccept(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // GET /dashboard/accept — show the invite carried in ?token= for the logged-in user to accept.
  app.get('/dashboard/accept', { preHandler: requireSession }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;
    const token = (req.query as { token?: string }).token ?? '';
    return reply.view('accept', { csrf: session.csrf, token, error: null });
  });

  // POST /dashboard/accept — accept the invite, then upgrade the session to a full tenant session.
  app.post('/dashboard/accept', { preHandler: requireSession }, async (req, reply) => {
    if (!assertCsrf(req)) {
      return reply.code(403).send('Forbidden: CSRF token mismatch');
    }
    const session = (req as typeof req & { session: DashboardSession }).session;
    const body = req.body as { token?: string };
    const token = (body.token ?? '').trim();
    const email = session.email ?? '';

    const result = await acceptInvitation(deps.pool, token, session.subject, email);
    if (result.status !== 'accepted') {
      void reply.code(400);
      return reply.view('accept', {
        csrf: session.csrf,
        token,
        error: ACCEPT_MESSAGES[result.status] ?? 'Could not accept invitation.',
      });
    }

    setSession(reply, {
      tenantId: result.tenantId,
      userId: result.userId,
      subject: session.subject,
      role: result.role,
      email,
    });
    return reply.redirect('/dashboard');
  });
}
```

- [ ] **Step 3: Create `src/dashboard/views/accept.eta`**

```eta
<% layout('./layout') %>
<h1>Accept Invitation</h1>

<% if (it.error) { %>
<div style="background:#ffebee;border:1px solid #c62828;color:#c62828;padding:0.75rem;margin-bottom:1rem;border-radius:4px">
  <%= it.error %>
</div>
<% } %>

<p>You've been invited to join a workspace. Paste your invitation token (from the link you were sent) and accept.</p>

<form method="post" action="/dashboard/accept">
  <input type="hidden" name="_csrf" value="<%= it.csrf %>">
  <label for="accept-token">Invitation token</label>
  <input type="text" id="accept-token" name="token" value="<%= it.token %>" style="margin-left:0.5rem;padding:0.35rem 0.5rem;width:24rem;font-family:monospace">
  <button type="submit" style="margin-left:0.5rem;padding:0.35rem 1rem">Accept</button>
</form>
```

Note: the layout's nav links point at tenant pages a pending user can't use; that's acceptable — `requireSession` redirects them back to `/dashboard/accept` if they click through. (The accept page itself renders under `requireSession`, which permits pending sessions on this path.)

- [ ] **Step 4: Add a smoke test** — create `tests/integration/dashboard/accept-smoke.test.ts` proving GET renders and bad CSRF is rejected (full accept flow is in Task 10):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sign } from '@fastify/cookie';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb } from '../_helpers/db.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerAccept } from '../../../src/dashboard/routes/accept.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

const SECRET = 'accept-smoke-secret-32-chars-long!!';

function cookie(s: DashboardSession): string {
  return `op_dash=${sign(JSON.stringify(s), SECRET)}`;
}

describe('accept route smoke', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    app = Fastify();
    await registerDashboard(app, {
      cookieSecret: SECRET,
      buildAuthorizationUrl: () => 'https://auth.example.com/login',
      authenticateWithCode: async () => ({ userId: 'u', email: 'p@example.com', subject: 'sub_p' }),
      resolveTenant: async () => ({ status: 'pending_invite' }),
      registerPages: (pageApp) => registerAccept(pageApp, { pool }),
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await fixture.stop();
  });

  it('GET /dashboard/accept with a pending session renders the form', async () => {
    const s: DashboardSession = { tenantId: '', userId: '', subject: 'sub_p', role: 'viewer', csrf: 'c1', pending: true, email: 'p@example.com' };
    const res = await app.inject({ method: 'GET', url: '/dashboard/accept?token=abc', headers: { cookie: cookie(s) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Accept Invitation');
    expect(res.body).toContain('abc');
  });

  it('POST /dashboard/accept with bad CSRF → 403', async () => {
    const s: DashboardSession = { tenantId: '', userId: '', subject: 'sub_p', role: 'viewer', csrf: 'c1', pending: true, email: 'p@example.com' };
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/accept',
      headers: { cookie: cookie(s), 'content-type': 'application/x-www-form-urlencoded' },
      payload: '_csrf=WRONG&token=abc',
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 5: Run + typecheck**

Run: `npx vitest run tests/integration/dashboard/accept-smoke.test.ts && npm run typecheck`
Expected: PASS. (Typecheck now forces every `registerDashboard({ resolveTenant })` caller — `src/server.ts` and the existing dashboard/e2e tests — to return `TenantResolution`; fix those in Task 13. For now the smoke test passes because it returns a valid resolution shape.)

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/routes/accept.ts src/dashboard/views/accept.eta tests/integration/dashboard/accept-smoke.test.ts
git commit -m "feat(phase6b): login pending_invite branch + accept routes"
```

---

## Task 10: Users/Team page — list + invite

**Files:**
- Create: `src/dashboard/routes/users.ts`
- Create: `src/dashboard/views/users.eta`
- Modify: `src/dashboard/views/layout.eta` (add nav link)
- Test: `tests/integration/dashboard/users.test.ts`

- [ ] **Step 1: Write the failing integration test** (`tests/integration/dashboard/users.test.ts`) — list + invite + accept-roundtrip sections:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sign } from '@fastify/cookie';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { registerDashboard } from '../../../src/dashboard/server.js';
import { registerUsers } from '../../../src/dashboard/routes/users.js';
import { registerAccept } from '../../../src/dashboard/routes/accept.js';
import type { DashboardSession } from '../../../src/dashboard/session.js';

const SECRET = 'users-page-secret-32-characters!!';
const CSRF = 'users-csrf-fixed';

function cookie(s: DashboardSession): string {
  return `op_dash=${sign(JSON.stringify(s), SECRET)}`;
}

describe('dashboard users page', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let ownerUserId: string;

  function ownerSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
    return { tenantId, userId: ownerUserId, subject: 'users_owner', role: 'owner', csrf: CSRF, email: 'users-owner@example.com', ...overrides };
  }

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ tenant_id: string; user_id: string }>(
        'SELECT * FROM resolve_or_provision_tenant($1,$2)',
        ['users_owner', 'users-owner@example.com'],
      );
      tenantId = r.rows[0]!.tenant_id;
      ownerUserId = r.rows[0]!.user_id;
    } finally {
      c.release();
    }

    app = Fastify();
    await registerDashboard(app, {
      cookieSecret: SECRET,
      buildAuthorizationUrl: () => 'https://auth.example.com/login',
      authenticateWithCode: async () => ({ userId: ownerUserId, email: 'users-owner@example.com', subject: 'users_owner' }),
      resolveTenant: async () => ({ status: 'resolved', tenantId, userId: ownerUserId, role: 'owner' }),
      registerPages: (pageApp) => {
        registerUsers(pageApp, { pool });
        registerAccept(pageApp, { pool });
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await fixture.stop();
  });

  it('GET /dashboard/users renders the owner in the member list', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/users', headers: { cookie: cookie(ownerSession()) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Team');
    expect(res.body).toContain('users-owner@example.com');
    expect(res.body).toContain('owner');
    expect(res.body).toContain('_csrf');
  });

  it('POST invite with bad CSRF → 403', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dashboard/users/invite',
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: '_csrf=WRONG&email=teammate@example.com&role=operator',
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST invite creates a pending invite and shows the accept link once', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dashboard/users/invite',
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&email=teammate@example.com&role=operator`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/dashboard/accept?token=');
    expect(res.body).toContain('teammate@example.com');

    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(
        `SELECT role FROM invitations WHERE email = 'teammate@example.com' AND accepted_at IS NULL`,
      );
      expect(r.rows[0]!.role).toBe('operator');
    });
  });

  it('POST invite for an email that is already a user is rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dashboard/users/invite',
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&email=users-owner@example.com&role=viewer`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/already (a )?member|already belongs|already a user/i);
  });

  it('a viewer is 403 on GET /dashboard/users', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/users', headers: { cookie: cookie(ownerSession({ role: 'viewer' })) } });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/integration/dashboard/users.test.ts`
Expected: FAIL — cannot find module `routes/users.js`.

- [ ] **Step 3: Create `src/dashboard/routes/users.ts`** (list + invite; role/remove/revoke added in Task 11). The token is `randomBytes(24).toString('base64url')`.

```ts
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { requireRole, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import { emailHasUser } from '../../auth/accept-invitation.js';
import { canManage, canAssignRole, wouldOrphanOwners } from '../user-admin.js';
import type { Role } from '../auth/roles.js';

interface MemberRow {
  id: string;
  email: string;
  role: Role;
  status: string;
}
interface InviteRow {
  id: string;
  email: string;
  role: Role;
  token: string;
  expires_at: Date;
}

const INVITABLE_ROLES: ReadonlySet<string> = new Set(['admin', 'operator', 'viewer']);

async function loadPage(pool: pg.Pool, tenantId: string) {
  return withTenantConn(pool, tenantId, async (client) => {
    const members = await client.query<MemberRow>(
      `SELECT id, email, role, status FROM users
        WHERE tenant_id = $1 AND status <> 'deleted'
        ORDER BY created_at ASC`,
      [tenantId],
    );
    const invites = await client.query<InviteRow>(
      `SELECT id, email, role, token, expires_at FROM invitations
        WHERE tenant_id = $1 AND accepted_at IS NULL
        ORDER BY created_at DESC`,
      [tenantId],
    );
    return { members: members.rows, invites: invites.rows };
  });
}

export function registerUsers(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // GET /dashboard/users — member list + pending invites
  app.get('/dashboard/users', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;
    const { members, invites } = await loadPage(deps.pool, session.tenantId);
    return reply.view('users', {
      csrf: session.csrf,
      actorRole: session.role,
      actorUserId: session.userId,
      members,
      invites,
      newInviteLink: null,
      error: null,
    });
  });

  // POST /dashboard/users/invite — create a pending invite, show the link once
  app.post('/dashboard/users/invite', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
    if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
    const session = (req as typeof req & { session: DashboardSession }).session;
    const body = req.body as { email?: string; role?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const role = (body.role ?? '').trim();

    let error: string | null = null;
    let newInviteLink: string | null = null;

    if (!email || !INVITABLE_ROLES.has(role)) {
      error = 'Provide an email and a role of admin, operator, or viewer.';
    } else if (!canAssignRole(session.role, role as Role)) {
      error = 'You may not assign that role.';
    } else if (await emailHasUser(deps.pool, email)) {
      error = 'That email already belongs to a user.';
    } else {
      const token = randomBytes(24).toString('base64url');
      try {
        await withTenantConn(deps.pool, session.tenantId, async (client) => {
          await client.query(
            `INSERT INTO invitations (tenant_id, email, role, token, created_by_user_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
            [session.tenantId, email, role, token, session.userId],
          );
        });
        newInviteLink = `/dashboard/accept?token=${token}`;
      } catch {
        error = 'There is already a pending invitation for that email.';
      }
    }

    const { members, invites } = await loadPage(deps.pool, session.tenantId);
    return reply.view('users', {
      csrf: session.csrf,
      actorRole: session.role,
      actorUserId: session.userId,
      members,
      invites,
      newInviteLink,
      error,
    });
  });
}
```

(Reference: `canManage`/`wouldOrphanOwners` are imported for Task 11; if your linter flags them unused until then, add the role/remove handlers in Task 11 in the same commit-free working tree before running lint.)

- [ ] **Step 4: Create `src/dashboard/views/users.eta`**

```eta
<% layout('./layout') %>
<h1>Team</h1>

<% if (it.error) { %>
<div style="background:#ffebee;border:1px solid #c62828;color:#c62828;padding:0.75rem;margin-bottom:1rem;border-radius:4px"><%= it.error %></div>
<% } %>

<% if (it.newInviteLink) { %>
<div style="background:#e8f5e9;border:2px solid #4caf50;padding:1rem;margin-bottom:1.5rem;border-radius:4px">
  <h2 style="margin-top:0;color:#2e7d32">Invitation created</h2>
  <p style="color:#c62828"><strong>Copy this link now — share it with your teammate.</strong></p>
  <div style="font-family:monospace;background:#fff;padding:0.75rem;border:1px solid #a5d6a7;border-radius:4px;word-break:break-all"><%= it.newInviteLink %></div>
</div>
<% } %>

<section style="margin-bottom:2rem">
  <h2>Invite a teammate</h2>
  <form method="post" action="/dashboard/users/invite">
    <input type="hidden" name="_csrf" value="<%= it.csrf %>">
    <input type="email" name="email" placeholder="teammate@example.com" required style="padding:0.35rem 0.5rem">
    <select name="role" style="padding:0.35rem 0.5rem;margin-left:0.5rem">
      <% if (it.actorRole === 'owner' || it.actorRole === 'admin') { %><option value="admin">admin</option><% } %>
      <option value="operator">operator</option>
      <option value="viewer">viewer</option>
    </select>
    <button type="submit" style="margin-left:0.5rem;padding:0.35rem 1rem">Send invite</button>
  </form>
</section>

<section style="margin-bottom:2rem">
  <h2>Members</h2>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f5f5f5">
      <th style="text-align:left;padding:0.5rem;border-bottom:1px solid #ddd">Email</th>
      <th style="text-align:left;padding:0.5rem;border-bottom:1px solid #ddd">Role</th>
      <th style="text-align:left;padding:0.5rem;border-bottom:1px solid #ddd">Actions</th>
    </tr></thead>
    <tbody>
    <% it.members.forEach(function(m) { %>
      <tr id="member-<%= m.id %>">
        <td style="padding:0.5rem;border-bottom:1px solid #eee"><%= m.email %></td>
        <td style="padding:0.5rem;border-bottom:1px solid #eee"><%= m.role %></td>
        <td style="padding:0.5rem;border-bottom:1px solid #eee">
          <% if (m.id !== it.actorUserId && (it.actorRole === 'owner' || m.role !== 'owner')) { %>
          <form method="post" action="/dashboard/users/<%= m.id %>/role" style="display:inline">
            <input type="hidden" name="_csrf" value="<%= it.csrf %>">
            <select name="role">
              <% if (it.actorRole === 'owner' || it.actorRole === 'admin') { %><option value="admin"<%= m.role === 'admin' ? ' selected' : '' %>>admin</option><% } %>
              <option value="operator"<%= m.role === 'operator' ? ' selected' : '' %>>operator</option>
              <option value="viewer"<%= m.role === 'viewer' ? ' selected' : '' %>>viewer</option>
            </select>
            <button type="submit">Change</button>
          </form>
          <form method="post" action="/dashboard/users/<%= m.id %>/remove" style="display:inline" onsubmit="return confirm('Remove this user and revoke their API keys?')">
            <input type="hidden" name="_csrf" value="<%= it.csrf %>">
            <button type="submit" style="color:#c62828">Remove</button>
          </form>
          <% } else { %><span style="color:#999">—</span><% } %>
        </td>
      </tr>
    <% }); %>
    </tbody>
  </table>
</section>

<section>
  <h2>Pending invitations</h2>
  <% if (it.invites.length === 0) { %><p>No pending invitations.</p><% } else { %>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f5f5f5">
      <th style="text-align:left;padding:0.5rem;border-bottom:1px solid #ddd">Email</th>
      <th style="text-align:left;padding:0.5rem;border-bottom:1px solid #ddd">Role</th>
      <th style="text-align:left;padding:0.5rem;border-bottom:1px solid #ddd">Expires</th>
      <th style="text-align:left;padding:0.5rem;border-bottom:1px solid #ddd">Actions</th>
    </tr></thead>
    <tbody>
    <% it.invites.forEach(function(inv) { %>
      <tr>
        <td style="padding:0.5rem;border-bottom:1px solid #eee"><%= inv.email %></td>
        <td style="padding:0.5rem;border-bottom:1px solid #eee"><%= inv.role %></td>
        <td style="padding:0.5rem;border-bottom:1px solid #eee"><%= new Date(inv.expires_at).toISOString().slice(0,10) %></td>
        <td style="padding:0.5rem;border-bottom:1px solid #eee">
          <form method="post" action="/dashboard/invitations/<%= inv.id %>/revoke" style="display:inline">
            <input type="hidden" name="_csrf" value="<%= it.csrf %>">
            <button type="submit" style="color:#c62828">Revoke</button>
          </form>
        </td>
      </tr>
    <% }); %>
    </tbody>
  </table>
  <% } %>
</section>
```

- [ ] **Step 5: Add the nav link** in `src/dashboard/views/layout.eta` — insert after the Confirmations link (line ~27):

```eta
  <a href="/dashboard/users">Team</a>
```

- [ ] **Step 6: Run to confirm pass**

Run: `npx vitest run tests/integration/dashboard/users.test.ts`
Expected: list/invite/dup-reject/viewer-403 cases PASS. (Role/remove/revoke cases are added in Task 11.)

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/routes/users.ts src/dashboard/views/users.eta src/dashboard/views/layout.eta tests/integration/dashboard/users.test.ts
git commit -m "feat(phase6b): Users/Team page — list + invite"
```

---

## Task 11: Change-role, remove (last-owner guard + key revocation), revoke invite

**Files:**
- Modify: `src/dashboard/routes/users.ts` (add three handlers)
- Test: `tests/integration/dashboard/users.test.ts` (add cases)

- [ ] **Step 1: Add failing tests** — append inside the `describe` block in `tests/integration/dashboard/users.test.ts`. They seed members via `accept_invitation` so the path is realistic.

```ts
  // Helper: create + accept an invite to materialise a member with a known role.
  async function seedMember(email: string, role: 'admin' | 'operator' | 'viewer', subject: string) {
    const token = `seed-${subject}`;
    await runAsTenant(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '7 days')`,
        [tenantId, email, role, token],
      );
    });
    const c = await pool.connect();
    try {
      await c.query('SET ROLE app_role');
      const r = await c.query<{ user_id: string }>(
        'SELECT * FROM accept_invitation($1,$2,$3)',
        [token, subject, email],
      );
      return r.rows[0]!.user_id;
    } finally {
      c.release();
    }
  }

  it('change-role: owner promotes an operator to admin', async () => {
    const uid = await seedMember('promote@example.com', 'operator', 'promote_sub');
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${uid}/role`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&role=admin`,
    });
    expect(res.statusCode).toBe(200);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [uid]);
      expect(r.rows[0]!.role).toBe('admin');
    });
  });

  it('change-role: an admin cannot modify an owner (403)', async () => {
    const adminId = await seedMember('admin1@example.com', 'admin', 'admin1_sub');
    const adminSession = ownerSession({ role: 'admin', userId: adminId, subject: 'admin1_sub', email: 'admin1@example.com' });
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${ownerUserId}/role`,
      headers: { cookie: cookie(adminSession), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&role=viewer`,
    });
    expect(res.statusCode).toBe(403);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [ownerUserId]);
      expect(r.rows[0]!.role).toBe('owner');
    });
  });

  it('change-role: demoting the last owner is rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${ownerUserId}/role`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}&role=admin`,
    });
    expect(res.statusCode).toBe(400);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [ownerUserId]);
      expect(r.rows[0]!.role).toBe('owner');
    });
  });

  it('remove: soft-deletes the user and revokes their API keys', async () => {
    const uid = await seedMember('removeme@example.com', 'operator', 'removeme_sub');
    let keyId = '';
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, prefix, hash, name, created_by_user_id)
         VALUES ($1, 'op_live_rm00', 'x', 'rm-key', $2) RETURNING id`,
        [tenantId, uid],
      );
      keyId = r.rows[0]!.id;
    });
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${uid}/remove`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}`,
    });
    expect(res.statusCode).toBe(200);
    await runAsTenant(pool, tenantId, async (client) => {
      const u = await client.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [uid]);
      expect(u.rows[0]!.status).toBe('deleted');
      const k = await client.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM api_keys WHERE id = $1`, [keyId]);
      expect(k.rows[0]!.revoked_at).not.toBeNull();
    });
  });

  it('remove: removing the last owner is rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: `/dashboard/users/${ownerUserId}/remove`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}`,
    });
    expect(res.statusCode).toBe(400);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [ownerUserId]);
      expect(r.rows[0]!.status).toBe('active');
    });
  });

  it('revoke pending invite: deletes the row', async () => {
    let inviteId = '';
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
         VALUES ($1, 'revokeinv@example.com', 'viewer', 'revoke-tok', now() + interval '7 days') RETURNING id`,
        [tenantId],
      );
      inviteId = r.rows[0]!.id;
    });
    const res = await app.inject({
      method: 'POST', url: `/dashboard/invitations/${inviteId}/revoke`,
      headers: { cookie: cookie(ownerSession()), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${CSRF}`,
    });
    expect(res.statusCode).toBe(200);
    await runAsTenant(pool, tenantId, async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM invitations WHERE id = $1`,
        [inviteId],
      );
      expect(r.rows[0]!.count).toBe('0');
    });
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/integration/dashboard/users.test.ts`
Expected: FAIL — the role/remove/revoke routes return 404 (not registered).

- [ ] **Step 3: Add the three handlers** to `src/dashboard/routes/users.ts`. A shared helper loads the target + active-owner count under RLS, then applies the pure guards.

```ts
  // POST /dashboard/users/:id/role — change a member's role
  app.post('/dashboard/users/:id/role', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
    if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
    const session = (req as typeof req & { session: DashboardSession }).session;
    const { id } = req.params as { id: string };
    const newRole = ((req.body as { role?: string }).role ?? '').trim();

    if (!INVITABLE_ROLES.has(newRole)) return reply.code(400).send('Invalid role.');

    const outcome = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const t = await client.query<{ role: Role; status: string }>(
        `SELECT role, status FROM users WHERE id = $1 AND tenant_id = $2`,
        [id, session.tenantId],
      );
      const target = t.rows[0];
      if (!target || target.status === 'deleted') return { code: 404 as const };
      if (!canManage(session.role, target.role)) return { code: 403 as const };
      if (!canAssignRole(session.role, newRole as Role)) return { code: 403 as const };
      const oc = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE tenant_id = $1 AND role = 'owner' AND status <> 'deleted'`,
        [session.tenantId],
      );
      if (wouldOrphanOwners(target.role, Number(oc.rows[0]!.count), { newRole: newRole as Role })) {
        return { code: 400 as const };
      }
      await client.query(`UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3`, [newRole, id, session.tenantId]);
      return { code: 200 as const };
    });

    if (outcome.code !== 200) return reply.code(outcome.code).send(outcome.code === 403 ? 'Forbidden' : 'Not allowed');
    const { members, invites } = await loadPage(deps.pool, session.tenantId);
    return reply.view('users', { csrf: session.csrf, actorRole: session.role, actorUserId: session.userId, members, invites, newInviteLink: null, error: null });
  });

  // POST /dashboard/users/:id/remove — soft-delete + revoke the user's API keys
  app.post('/dashboard/users/:id/remove', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
    if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
    const session = (req as typeof req & { session: DashboardSession }).session;
    const { id } = req.params as { id: string };

    const outcome = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const t = await client.query<{ role: Role; status: string }>(
        `SELECT role, status FROM users WHERE id = $1 AND tenant_id = $2`,
        [id, session.tenantId],
      );
      const target = t.rows[0];
      if (!target || target.status === 'deleted') return { code: 404 as const };
      if (!canManage(session.role, target.role)) return { code: 403 as const };
      const oc = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE tenant_id = $1 AND role = 'owner' AND status <> 'deleted'`,
        [session.tenantId],
      );
      if (wouldOrphanOwners(target.role, Number(oc.rows[0]!.count), 'remove')) return { code: 400 as const };
      await client.query(`UPDATE users SET status = 'deleted' WHERE id = $1 AND tenant_id = $2`, [id, session.tenantId]);
      await client.query(
        `UPDATE api_keys SET revoked_at = now() WHERE created_by_user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
        [id, session.tenantId],
      );
      return { code: 200 as const };
    });

    if (outcome.code !== 200) return reply.code(outcome.code).send(outcome.code === 403 ? 'Forbidden' : 'Not allowed');
    const { members, invites } = await loadPage(deps.pool, session.tenantId);
    return reply.view('users', { csrf: session.csrf, actorRole: session.role, actorUserId: session.userId, members, invites, newInviteLink: null, error: null });
  });

  // POST /dashboard/invitations/:id/revoke — delete a pending invite (frees the unique-email slot)
  app.post('/dashboard/invitations/:id/revoke', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
    if (!assertCsrf(req)) return reply.code(403).send('Forbidden: CSRF token mismatch');
    const session = (req as typeof req & { session: DashboardSession }).session;
    const { id } = req.params as { id: string };
    await withTenantConn(deps.pool, session.tenantId, async (client) => {
      await client.query(`DELETE FROM invitations WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL`, [id, session.tenantId]);
    });
    const { members, invites } = await loadPage(deps.pool, session.tenantId);
    return reply.view('users', { csrf: session.csrf, actorRole: session.role, actorUserId: session.userId, members, invites, newInviteLink: null, error: null });
  });
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/integration/dashboard/users.test.ts`
Expected: ALL cases PASS (list/invite from Task 10 + the 6 new cases).

- [ ] **Step 5: Lint (helpers now used) + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS (`canManage`/`wouldOrphanOwners` are now referenced).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/routes/users.ts tests/integration/dashboard/users.test.ts
git commit -m "feat(phase6b): change-role + remove (last-owner guard + key revocation) + revoke invite"
```

---

## Task 12: RBAC gates on existing routes + wire registerUsers/registerAccept

**Files:**
- Modify: `src/dashboard/routes/openprovider.ts`, `policy.ts`, `keys.ts`, `confirmations.ts`
- Modify: `src/server.ts` (return `TenantResolution`; register users + accept pages)
- Modify: existing dashboard/e2e tests that pass `resolveTenant` returning `{tenantId,userId}` (now must return `TenantResolution`)
- Test: `tests/integration/dashboard/users.test.ts` (add cross-route RBAC cases)

- [ ] **Step 1: Add failing RBAC tests** — append to `tests/integration/dashboard/users.test.ts`. They need the management pages registered, so extend the `registerPages` block in this file's `beforeAll` to also register policy + keys + openprovider + overview + audit + confirmations (copy the imports + `registerPages` body from `pages-manage.test.ts`, passing `kms`/`kmsKeyName`/`openproviderClient` the same way). Then:

```ts
  it('viewer is 403 on /dashboard/policy and /dashboard/keys but 200 on /dashboard (overview)', async () => {
    const viewer = ownerSession({ role: 'viewer' });
    expect((await app.inject({ method: 'GET', url: '/dashboard/policy', headers: { cookie: cookie(viewer) } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/dashboard/keys', headers: { cookie: cookie(viewer) } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: cookie(viewer) } })).statusCode).toBe(200);
  });

  it('admin is allowed on /dashboard/policy + /dashboard/keys but 403 on /dashboard/openprovider (owner-only creds)', async () => {
    const admin = ownerSession({ role: 'admin' });
    expect((await app.inject({ method: 'GET', url: '/dashboard/policy', headers: { cookie: cookie(admin) } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/dashboard/keys', headers: { cookie: cookie(admin) } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/dashboard/openprovider', headers: { cookie: cookie(admin) } })).statusCode).toBe(403);
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/integration/dashboard/users.test.ts`
Expected: FAIL — viewer/admin currently get 200 everywhere (routes use `requireSession`, not `requireRole`).

- [ ] **Step 3: Apply `requireRole` gates.** In each route file, replace the `preHandler` for the gated endpoints:

`src/dashboard/routes/openprovider.ts` — import `requireRole` and gate **all** routes (GET + POST) with `requireRole('owner')` (creds rotation is owner-only). Change `import { requireSession, ... }` to also import `requireRole`, and replace each `{ preHandler: requireSession }` with `{ preHandler: requireRole('owner') }`.

`src/dashboard/routes/policy.ts` — gate all routes with `requireRole('owner', 'admin')`.

`src/dashboard/routes/keys.ts` — gate all three routes with `requireRole('owner', 'admin')`.

`src/dashboard/routes/confirmations.ts` — GET list keeps `requireSession` (all roles may view); the approve POST route changes to `requireRole('owner', 'admin')`.

(Overview and audit keep `requireSession` — all roles.)

- [ ] **Step 4: Wire the new pages + fix the resolver return in `src/server.ts`.**

Add imports near the other route imports:

```ts
import { registerUsers } from './dashboard/routes/users.js';
import { registerAccept } from './dashboard/routes/accept.js';
```

Change the dashboard `resolveTenant` adapter (lines ~432–435) to pass the resolution through unchanged (it is already a `TenantResolution`):

```ts
    resolveTenant,
```

(Delete the old `async (subject, email) => { const t = await resolveTenant(...); return { tenantId, userId }; }` wrapper — `createTenantResolver` now returns the exact `TenantResolution` the dashboard expects.)

Add the two new pages inside `registerPages`:

```ts
      registerUsers(pageApp, { pool });
      registerAccept(pageApp, { pool });
```

- [ ] **Step 5: Fix existing tests that stub `resolveTenant`.** In `tests/integration/dashboard/pages-manage.test.ts`, `tests/integration/dashboard/pages-core.test.ts`, and `tests/integration/mcp/dashboard-key-e2e.test.ts`, change every `resolveTenant: async () => ({ tenantId..., userId... })` to `resolveTenant: async () => ({ status: 'resolved' as const, tenantId, userId, role: 'owner' as const })`. Also ensure each `makeSession`/session literal includes `role: 'owner'` (the `DashboardSession` now requires it).

- [ ] **Step 6: Run the affected suites + typecheck + lint**

Run: `npx vitest run tests/integration/dashboard/ tests/integration/mcp/dashboard-key-e2e.test.ts && npm run typecheck && npm run lint`
Expected: PASS. Specifically the two new RBAC cases pass and no existing dashboard test regressed.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/routes/openprovider.ts src/dashboard/routes/policy.ts src/dashboard/routes/keys.ts src/dashboard/routes/confirmations.ts src/server.ts tests/integration/dashboard/ tests/integration/mcp/dashboard-key-e2e.test.ts
git commit -m "feat(phase6b): requireRole gates per RBAC matrix + wire users/accept pages"
```

---

## Task 13: E2E — two-user operator-proposes / owner-approves

**Files:**
- Create: `tests/integration/mcp/rbac-e2e.test.ts`

**Approach:** Boot one `createMcpServer` app with a **fake OAuth verifier** that maps two bearer strings → two WorkOS identities (owner + operator), and the **real** `createTenantResolver(pool)`. Seed the owner via `resolve_or_provision_tenant`; materialise the operator via an invite + `accept_invitation`. Seed the Openprovider account + password + a `confirm`-mode policy so `register_domain` requires approval. The `dispatchFactory` is the Phase-5 variant from `tests/integration/mcp/e2e.test.ts` (the block around lines 952–1200 that wires `createRegisterDomainTool`, the `confirm` resolveMode, the `approver_role_required` check keyed on `principal.role`, and `confirm_pending`). Clone that factory verbatim into this file.

- [ ] **Step 1: Write the e2e test** (`tests/integration/mcp/rbac-e2e.test.ts`). The MCP HTTP helpers (`mcpInitSession`, `mcpCallTool`) are the same as in `dashboard-key-e2e.test.ts` — copy them. The unique parts:

```ts
// --- identities ---
const OWNER_BEARER = 'owner-bearer-token';
const OPERATOR_BEARER = 'operator-bearer-token';

// fake verifier maps bearer → {subject,email,expiresAt}
const verifier = async (token: string) => {
  if (token === OWNER_BEARER) return { subject: 'rbac_owner_sub', email: 'rbac-owner@example.com', expiresAt: Date.now() + 60_000 };
  if (token === OPERATOR_BEARER) return { subject: 'rbac_operator_sub', email: 'rbac-operator@example.com', expiresAt: Date.now() + 60_000 };
  throw new Error('bad token');
};

// in beforeAll, after migratedDb:
const resolveTenant = createTenantResolver(pool);

// 1) provision owner
let tenantId = '';
{
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ tenant_id: string }>('SELECT * FROM resolve_or_provision_tenant($1,$2)', ['rbac_owner_sub', 'rbac-owner@example.com']);
    tenantId = r.rows[0]!.tenant_id;
  } finally { c.release(); }
}
// 2) invite + accept operator into the SAME tenant
await runAsTenant(pool, tenantId, async (client) => {
  await client.query(
    `INSERT INTO invitations (tenant_id, email, role, token, expires_at)
     VALUES ($1, 'rbac-operator@example.com', 'operator', 'rbac-op-tok', now() + interval '7 days')`,
    [tenantId],
  );
});
{
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
    const r = await c.query<{ status: string }>('SELECT * FROM accept_invitation($1,$2,$3)', ['rbac-op-tok', 'rbac_operator_sub', 'rbac-operator@example.com']);
    expect(r.rows[0]!.status).toBe('accepted');
  } finally { c.release(); }
}
// 3) seed OP account + password + confirm-mode policy (register_domain → confirm, cap high)
//    (identical to e2e.test.ts Phase-5 seeding: openprovider_accounts row, secrets store put,
//     policies doc { register_domain: 'confirm', requiredApproverRoles default owner/admin }).

// 4) createMcpServer with: verifier, resolveTenant, dispatchFactory (Phase-5 clone),
//    devToken unused. No apiKeyResolver needed.
```

```ts
// --- the scenario ---
it('operator proposes register_domain; operator confirm rejected; owner confirm approved', async () => {
  // Operator initialises + proposes → confirmation_required (returns a confirmation id).
  const { sid: opSid } = await mcpInitSession(OPERATOR_BEARER);
  const propose = await mcpCallTool(opSid, OPERATOR_BEARER, 'register_domain', domainArgs) as
    { result?: { content: { text: string }[] } };
  const proposeText = propose.result!.content[0]!.text;
  const confirmationId = JSON.parse(proposeText).confirmation_id as string; // matches Phase-5 propose shape
  expect(confirmationId).toBeTruthy();

  // Nock the upstream so an approval would actually execute.
  nock('https://api.openprovider.eu').post('/v1beta/auth/login').reply(200, { data: { token: 'jwt', reseller_id: 1 } });
  nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(200, { data: { results: [{ domain: 'rbac.com', status: 'free', price: { product: { price: 12.0, currency: 'EUR' } } }] } });
  nock('https://api.openprovider.eu').post('/v1beta/domains').reply(200, { data: { id: 1, domain: 'rbac.com', status: 'ACT' } });

  // Operator tries to confirm → rejected (approver_role_required).
  const { sid: opSid2 } = await mcpInitSession(OPERATOR_BEARER);
  const opConfirm = await mcpCallTool(opSid2, OPERATOR_BEARER, 'confirm_pending', { confirmationId, ...domainArgs }) as
    { result?: { content: { text: string }[] }; error?: unknown };
  const opConfirmText = JSON.stringify(opConfirm);
  expect(opConfirmText).toMatch(/approver_role_required/);

  // Owner confirms the SAME confirmation → succeeds.
  const { sid: ownSid } = await mcpInitSession(OWNER_BEARER);
  const ownConfirm = await mcpCallTool(ownSid, OWNER_BEARER, 'confirm_pending', { confirmationId, ...domainArgs }) as
    { result?: { content: { text: string }[] } };
  expect(JSON.stringify(ownConfirm)).not.toMatch(/approver_role_required/);
  expect(ownConfirm.result?.content[0]?.text).toBeDefined();
}, 120_000);
```

> When cloning the dispatchFactory and `domainArgs`/propose-response shape, match `tests/integration/mcp/e2e.test.ts` Phase-5 exactly (the `confirmation_id` field name, the `domainArgs` object, the `requiredApproverRoles` check at the `callerRole` line, and the `META_TOOLS` allow-set). Do not invent field names — read that file and copy.

- [ ] **Step 2: Run the e2e**

Run: `npx vitest run tests/integration/mcp/rbac-e2e.test.ts`
Expected: PASS — operator proposal returns a confirmation id, operator confirm is rejected with `approver_role_required`, owner confirm succeeds.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcp/rbac-e2e.test.ts
git commit -m "test(phase6b): e2e two-user operator-proposes/owner-approves"
```

---

## Task 14: Full suite + docs

**Files:**
- Modify: `README.md` (Phase 6b section)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the entire suite + typecheck + lint**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all unit + integration green (Docker up). Investigate and fix any regression before proceeding.

- [ ] **Step 2: Update `README.md`** — add a "Phase 6b — Team & RBAC" subsection documenting: token'd invite link (`/dashboard/accept?token=…`), the explicit-accept + email-match rule, the 4-role matrix table (copy from the spec §6), last-owner guard, remove-revokes-keys, and that invite email delivery is deferred (link shown once in the UI).

- [ ] **Step 3: Update `CHANGELOG.md`** — add an entry under a new `0.2.0-phase6b` heading summarizing: invitations (migration 0012) + `accept_invitation`/`email_has_user`, dashboard Users/Team page, `requireRole` gating, resolver `pending_invite` branch, two-user e2e.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(phase6b): README + CHANGELOG for Team & RBAC"
```

- [ ] **Step 5: STOP — do not push.** Per the standing instruction, pause here and report to the user for a single review + push approval covering the whole phase.

---

## Self-Review

**1. Spec coverage:**
- Spec §2 invitations table → Task 1. ✅
- Spec §3(a) resolve pending_invite branch → Task 2; §3(b) accept_invitation → Task 3; §3(c) email_has_user → Task 4. ✅
- Spec §4 accept flow (login redirect + GET/POST accept + email match) → Task 9 (+ branch in `server.ts`), email match enforced in `accept_invitation` (Task 3). ✅
- Spec §5 session role + requireRole + pending → Task 8. ✅
- Spec §6 RBAC matrix → Task 12 (dashboard gates); MCP rows proven by Task 13. ✅
- Spec §7 Users/Team page (list/invite/role/remove/revoke, last-owner guard, key revocation) → Tasks 10–11. ✅
- Spec §8 tests: unit (requireRole, last-owner helper) Tasks 7–8; integration (resolve branch, accept, email_has_user, users page, RBAC) Tasks 2–4,10–12; e2e Task 13. ✅
- Spec §9 file structure → matches the File Structure table (added `src/auth/roles.ts` and `src/dashboard/user-admin.ts` for DRY/testability; noted). ✅
- Spec §10 out-of-scope: no WorkOS orgs / multi-tenant / email delivery / ownership transfer — none introduced. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. Task 13 intentionally instructs cloning the proven Phase-5 dispatchFactory from `e2e.test.ts` (an existing committed file, cited by location) rather than reprinting ~200 lines — the engineer reads real code, not a placeholder.

**3. Type consistency:** `Role` defined once in `src/auth/roles.ts` and imported everywhere (`tenant-resolver`, `accept-invitation`, `session`, `user-admin`, `users` route). `TenantResolution` is the discriminated union returned by `createTenantResolver` and consumed identically in `identity.ts` (Task 5) and `server.ts` (Tasks 9, 12). `AcceptResult.status === 'accepted'` narrows to `{tenantId,userId,role}` — used consistently in the accept route (Task 9) and tests. `DashboardSession` gains `role`/`pending`/`email` in Task 8 and every constructor/literal is updated (Tasks 9–12). Function names stable across tasks: `acceptInvitation`, `emailHasUser`, `canManage`, `canAssignRole`, `wouldOrphanOwners`, `requireRole`, `loadPage`, `registerUsers`, `registerAccept`. ✅

*End of plan.*

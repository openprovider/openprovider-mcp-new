# Phase 6c — Local Email+Password Auth (replaces WorkOS) — Design Spec

- **Status:** Approved (brainstormed 2026-05-27)
- **Scope:** Replace WorkOS AuthKit (OAuth) with self-hosted email+password authentication for the dashboard, preserving the Phase-6b multi-user invitation + RBAC model. Self-signup provisions a tenant+owner; teammates join by token'd invite (accepting sets a password); owner/admin can issue token'd password-reset links. `/mcp` authenticates by API key (and the dev token) only — the WorkOS JWT bearer path is removed.
- **Parent specs:** `2026-05-21-enterprise-mcp-design.md` (§5 RBAC), `2026-05-27-phase6b-rbac-design.md` (invitations + RBAC, which this adapts).
- **Builds on / replaces:** Phases 1–7 + 6b. This is a foundation swap of the identity layer; it removes WorkOS entirely.
- **Branch:** `feat/enterprise-phase-1`.

---

## 1. Decisions (from brainstorming)

1. **Fully replace WorkOS** — delete the verifier, hosted-login, OAuth bearer path, `@workos-inc/node`, and all `WORKOS_*` config.
2. **Open self-signup** — a public signup page provisions a new tenant + owner (mirrors the old JIT provisioning). Teammates still join only by invite.
3. **API-keys-only for `/mcp`** — humans use the dashboard (signed-cookie session); MCP clients/service accounts use `op_live_` API keys. The dev bearer token remains. No local JWTs.
4. **Admin-initiated token'd password reset, no email** — owner/admin generates a single-use reset link shown once in the UI (self-service "forgot password" needs an email channel, which stays deferred). Plus logged-in change-password. No email verification.
5. **SECURITY DEFINER functions** confine every cross-tenant op (signup, login lookup, accept, reset) — consistent with the Phase 3/6b RLS model; no app-layer cross-tenant queries.

---

## 2. Data model + DB (migration 0013, journal idx 12)

**`users` changes:**
```sql
ALTER TABLE users ADD COLUMN password_hash text;          -- nullable; set on signup/accept/reset
ALTER TABLE users ALTER COLUMN oauth_subject DROP NOT NULL; -- kept (door open for future SSO), no longer used
CREATE UNIQUE INDEX users_email_active ON users (lower(email)) WHERE status <> 'deleted';
```
`users_email_active` enforces **one active account per email globally** (login is a global email lookup; matches "one user = one tenant").

**`password_resets` (new, RLS-scoped):**
```sql
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

**SECURITY DEFINER functions** (all `search_path = public`, `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO app_role`). These replace the OAuth-shaped `resolve_or_provision_tenant` (dropped):

- **`signup_tenant(p_email text, p_password_hash text) RETURNS (status text, tenant_id uuid, user_id uuid, role text)`** — if an active user with `lower(email)` exists → `{status:'email_taken'}`; else provision tenant + default policy (the exact JSON doc reused from migration 0008/0012 branch 3) + owner user with `password_hash`, returning `{status:'created', …, role:'owner'}`. Keeps the savepoint/`unique_violation` retry guard.
- **`find_user_by_email(p_email text) RETURNS (user_id uuid, tenant_id uuid, role text, status text, password_hash text)`** — cross-tenant lookup for login verification (server compares the hash). Returns no row if not found / deleted.
- **`accept_invitation(p_token text, p_password_hash text) RETURNS (status text, tenant_id uuid, user_id uuid, role text)`** — **new signature** (drops `subject`/email-match; token possession is the auth, like a reset link). Validates: token exists, `accepted_at IS NULL`, not expired, and no active user already has the invite's email (`email_taken`). Atomically claims (`UPDATE … WHERE accepted_at IS NULL RETURNING`) and inserts the user with the invite's email + role + `password_hash`. Statuses: `accepted | invalid_token | already_accepted | expired | email_taken`.
- **`consume_password_reset(p_token text, p_password_hash text) RETURNS (status text, user_id uuid)`** — cross-tenant by token; validates exists/unused/unexpired, sets the user's `password_hash`, marks `used_at`. Statuses: `ok | invalid_token | expired | already_used`.

  (Reset *creation* is **not** a definer function — it happens within the tenant: the owner/admin route inserts a `password_resets` row under the tenant's RLS context via `withTenantConn` (the target `user_id` is constrained to the tenant by the FK + the RLS INSERT `WITH CHECK`). Only the token-based *consume* — invoked by a not-yet-logged-in user — needs the definer.)
- **`email_has_user(p_email text)`** — kept unchanged (invite-creation guard).

---

## 3. Dashboard auth flows

New `src/auth/password.ts` — `hashPassword(pw)` / `verifyPassword(hash, pw)` (argon2id, same params as `api-key.ts`: `argon2id, memoryCost 65536, timeCost 3`). Password policy: **min 12 chars** (server-enforced).

New `src/auth/local-auth.ts` — thin pool wrappers over the definer functions (`signup`, `findUserByEmail`, `acceptInvitation(token, passwordHash)`, `consumePasswordReset`), each `SET ROLE app_role` then call the function (mirrors `accept-invitation.ts`).

Routes (new `src/dashboard/routes/auth.ts`, registered by `registerDashboard`):
- `GET /dashboard/signup` → form; `POST /dashboard/signup` (email, password) → `signup` → on `email_taken` re-render with error; else `setSession({tenantId,userId,subject:email,role:'owner',email})` → `/dashboard`.
- `GET /dashboard/login` → form; `POST /dashboard/login` (email, password) → `findUserByEmail` + `verifyPassword` → `setSession` → `/dashboard`. Generic error "Invalid email or password" on any failure. **Per-IP rate-limit** on this POST via `@fastify/rate-limit` (already a dep).
- `GET /dashboard/accept?token=` → set-password form (token hidden + new password); `POST /dashboard/accept` (token, password) → `acceptInvitation` → on `accepted` setSession → `/dashboard`; else friendly message.
- `GET /dashboard/reset?token=` → set-password form; `POST /dashboard/reset` (token, password) → `consumePasswordReset` → redirect `/dashboard/login` with a "password updated" notice.
- `POST /dashboard/account/password` (requireSession) → verify current password + set new (under tenant RLS, updates own `users.password_hash`).
- `POST /dashboard/logout` — unchanged.

`DashboardSession` is unchanged (`subject` is set to the email now). `setSession`/`requireSession`/`requireRole`/RBAC gating all unchanged. The dashboard nav/layout unchanged except the login page becoming a local form with a "Sign up" link.

**Users/Team page (`src/dashboard/routes/users.ts`):** add a **"Reset password"** action per member (owner/admin, CSRF'd) → inserts a `password_resets` row under the tenant (RLS) and shows the `/dashboard/reset?token=…` link **once** (mirrors the invite-link UI). Invite + change-role + remove + revoke unchanged in behavior; the accept side now sets a password.

---

## 4. MCP + WorkOS removal

- `src/auth/identity.ts` — remove the `verifier && resolveTenant` branch. `/mcp` resolves: dev token → `devPrincipal`; `op_live_…` → `apiKeyResolver`; else `null` (401). Remove `verifier`/`resolveTenant` from `IdentityResolverConfig`.
- Delete `src/auth/oauth/workos.ts` + `src/auth/oauth/workos.test.ts`, and `src/auth/tenant-resolver.ts` (replaced by `local-auth.ts`).
- `src/config.ts` — remove `WORKOS_CLIENT_ID|API_KEY|AUTHKIT_DOMAIN|JWKS_URI|ISSUER`. Remove from `.env`/`.env.example`.
- `package.json` — remove `@workos-inc/node`.
- `src/server.ts` — remove the `WorkOS` client + hosted-login deps; wire `registerDashboard` with `{ pool, cookieSecret, registerPages }` + the local-auth wrappers; drop `verifier`/`resolveTenant` from `createMcpServer`.
- `src/dashboard/server.ts` — `DashboardDeps` drops `buildAuthorizationUrl`/`authenticateWithCode`/`resolveTenant`; gains the local-auth function deps. Login/signup/accept/reset/logout registered here (or via `routes/auth.ts`).

---

## 5. Security

- Passwords: argon2id (`memoryCost 65536, timeCost 3`); never logged; min 12 chars.
- Tokens (invite + reset): `randomBytes(32).toString('base64url')` (256-bit), single-use, expiring — invites 7d (existing), resets **1h**.
- Login: generic "Invalid email or password"; per-IP rate-limit on `POST /dashboard/login`. (Signup may reveal email-existence via "email already in use" — accepted UX trade-off.)
- Reset is **admin-initiated only** (no self-service forgot-password without an email channel) — documented limitation.
- Cookie `secure` flag remains the Phase-8 hardening item (env-gated).
- Cross-tenant reads/writes only via the SECURITY DEFINER functions; everything else under RLS via `withTenantConn`.

---

## 6. Tests

- **Unit:** `password.ts` hash/verify (verify true/false; distinct hashes for same input); min-length validation.
- **Integration (testcontainers):**
  - `signup_tenant` — provisions tenant+owner+default policy+password; second signup with same email → `email_taken`.
  - `find_user_by_email` — returns the row+hash; none for unknown/deleted.
  - `accept_invitation(token, hash)` — accepted creates the user with invite email/role + password; reject paths (invalid/expired/already-accepted/email_taken); concurrent accept → one winner.
  - `consume_password_reset` — ok sets the hash; invalid/expired/already-used reject; single-use.
  - Dashboard routes: signup→login round-trip; wrong password → generic error; invite→accept-sets-password→login as invitee; admin issues reset → consume → login with new password; change-password (logged in); RBAC gates (viewer 403 etc.) still hold.
  - MCP: `op_live_` API key still authenticates `/mcp`; the old WorkOS-JWT bearer is rejected (401); read/write RBAC + the viewer write-gate still enforced.
- **E2E:** signup owner → invite operator → operator opens accept link, sets password, logs in → operator issues an API key (or owner issues one for them) → operator proposes `register_domain` via `/mcp` (API key) → owner approves via `confirm_pending`. The full local-auth + RBAC loop.

---

## 7. Migration / cutover note

Existing WorkOS-provisioned users carry `oauth_subject` and have `password_hash = NULL` → they cannot log in until a password is set (owner issues a reset link, or they re-signup if their tenant is empty). Dev/test databases are fresh, so this is a clean cutover. No data migration tooling is built (pre-1.0).

---

## 8. File structure

| File | Change | Responsibility |
|---|---|---|
| `migrations/0013_local_auth.sql` | new | users `password_hash` + nullable `oauth_subject` + global email unique index; `password_resets` table; drop `resolve_or_provision_tenant`; add `signup_tenant`, `find_user_by_email`, replace `accept_invitation`, add `consume_password_reset`. |
| `migrations/meta/_journal.json` | mod | idx 12, tag `0013_local_auth`. |
| `src/db/schema.ts` | mod | `users.passwordHash`; `passwordResets` mirror. |
| `src/auth/password.ts` | new | argon2id hash/verify + policy. |
| `src/auth/local-auth.ts` | new | signup / findUserByEmail / acceptInvitation / consumePasswordReset wrappers. |
| `src/auth/identity.ts` | mod | drop WorkOS branch (API-keys + dev token only). |
| `src/auth/oauth/workos.ts` (+test) | delete | — |
| `src/auth/tenant-resolver.ts` | delete | replaced by local-auth. |
| `src/auth/accept-invitation.ts` | mod | new `acceptInvitation(token, passwordHash)` signature; `emailHasUser` kept. |
| `src/dashboard/server.ts` | mod | local `DashboardDeps`; register auth routes. |
| `src/dashboard/routes/auth.ts` | new | signup/login/accept/reset/change-password. |
| `src/dashboard/routes/users.ts` | mod | "Reset password" action. |
| `src/dashboard/views/{login,signup,accept,reset}.eta` | new/mod | local-auth forms. |
| `src/config.ts` | mod | remove `WORKOS_*`. |
| `src/server.ts` | mod | remove WorkOS wiring; wire local auth. |
| `package.json` | mod | remove `@workos-inc/node`. |
| tests | new/mod | per §6 (Phase-6b accept tests updated to the new signature). |

---

## 9. Out of scope

- Self-service forgot-password (needs an email channel — deferred with email delivery).
- Email verification on signup; SSO/SAML/SCIM; social login.
- Data-migration tooling for existing WorkOS users (pre-1.0 clean cutover).
- 2FA / TOTP (future hardening).
- Local bearer tokens for `/mcp` (API keys cover programmatic access).

---

*End of spec.*

# Phase 6b — Multi-User Invitation + RBAC — Design Spec

- **Status:** Approved (brainstormed 2026-05-27)
- **Scope:** Multi-user tenants — token'd email invitations with explicit accept, a Users/Team dashboard page, and full owner/admin/operator/viewer RBAC enforced across the dashboard (the MCP/tool side already gates on the DB role from Phase 3). Completes the multi-user piece deferred from Phase 6.
- **Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §5 (RBAC).
- **Builds on:** Phases 1–7 (`feat/enterprise-phase-1`); especially Phase 3 (`resolve_or_provision_tenant`) and Phase 6 (dashboard + session).

---

## 1. Decisions taken in brainstorming

1. **Local token'd email invitations + explicit accept** (no WorkOS Organizations). The invite link `/dashboard/accept?token=…` is the bearer; acceptance additionally requires the logged-in **verified WorkOS email to match** the invitation's email (a leaked token can't be redeemed by someone else).
2. **One user = exactly one tenant.** A WorkOS subject resolves to a single tenant forever (their provisioned one, or the one they accepted an invite into). An invite for an email that already belongs to a user is rejected.
3. **Full 4-role matrix** (owner/admin/operator/viewer) enforced on the dashboard; the MCP side already enforces it via `policies/engine`.
4. **Last-owner guard:** a tenant always keeps ≥1 owner — the final owner can't be demoted or removed.
5. **Removing a user revokes their API keys.**

---

## 2. `invitations` table (migration 0012)

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
CREATE UNIQUE INDEX invitations_pending_email ON invitations (email) WHERE accepted_at IS NULL;
CREATE INDEX invitations_token ON invitations (token);
```

Journal entry `idx: 11, tag: 0012_invitations`. `role` excludes `owner` — you can't invite a second owner (ownership transfer is out of scope). Drizzle mirror `invitations` added to `src/db/schema.ts`.

---

## 3. SECURITY DEFINER functions (migration 0012)

Three cross-tenant operations are confined to definer functions (mirroring the Phase 3/6 pattern), all `search_path = public`, `EXECUTE` to `app_role` only:

**(a) `resolve_or_provision_tenant(p_subject, p_email)` — replaced.** New middle branch:
1. User by `oauth_subject` → return `{tenant_id, user_id, role, status:'resolved'}`.
2. No user, but a pending non-expired invite matches `p_email` → return `{status:'pending_invite'}` (NULL ids); **do not provision**.
3. Else → provision new tenant + owner user + default policy → return `{..., status:'resolved'}`.

The RETURN signature gains a `status text` column. The savepoint LOOP + `unique_violation` handling stays.

**(b) `accept_invitation(p_token, p_subject, p_email)` — new.** Validates: invite exists by token, `accepted_at IS NULL`, `expires_at > now()`, `email = p_email` (verified WorkOS email must match), and NO existing user has `oauth_subject = p_subject`. Then atomically claims (`UPDATE invitations SET accepted_at = now() WHERE id = $ AND accepted_at IS NULL RETURNING` — one winner) and `INSERT`s a `users` row into the invite's tenant with the invited role. Returns `{tenant_id, user_id, role}` or raises a typed condition (mapped to a friendly error). Concurrent accepts: only the claim winner proceeds.

**(c) `email_has_user(p_email) → boolean` — new.** Cross-tenant existence check used by the invite-creation guard (you can't see other tenants' users under RLS).

---

## 4. Accept flow (the token'd link)

- `/dashboard/login/callback`: call `resolve_or_provision_tenant`. If `status='resolved'` → set full session `{tenantId, userId, subject, role}` → `/dashboard`. If `status='pending_invite'` → set a **minimal pre-tenant session** `{subject, email, pending:true}` → redirect `/dashboard/accept`.
- `GET /dashboard/accept` (requires the pre-tenant or full session): lists pending invites for the logged-in verified email (joined by email — a definer read or the token from the query) with an Accept button (CSRF'd, carries the token).
- `POST /dashboard/accept` (token + CSRF): `accept_invitation(token, subject, email)` → on success upgrade the session to the full tenant session → `/dashboard`; on failure (wrong email / expired / already-accepted / subject-already-a-user) render a clear message.
- **Edge:** an invitee who logs in via the *normal* path before accepting hits branch 2 (`pending_invite`) and is routed to accept — they are never auto-provisioned while a pending invite exists for their email. (If they had already self-provisioned earlier, branch 1 returns their own tenant and the invite stays pending until it expires — documented limitation; the owner can revoke it.)

---

## 5. Session + `requireRole`

The dashboard `DashboardSession` gains `role: 'owner'|'admin'|'operator'|'viewer'` and an optional `pending: true` pre-tenant marker. `requireRole(...allowed: Role[])` is a preHandler composed after `requireSession` that 403s (friendly render) when `session.role` ∉ `allowed`. The role is read from the `users` row at login/accept and stored in the signed session cookie.

---

## 6. RBAC matrix (enforced)

| Surface | owner | admin | operator | viewer |
|---|---|---|---|---|
| Overview / audit (view) | ✓ | ✓ | ✓ | ✓ |
| Openprovider creds (rotate) | ✓ | — | — | — |
| Policy edit | ✓ | ✓ | — | — |
| API keys issue/revoke | ✓ | ✓ | — | — |
| Users/Team (invite/role/remove) | ✓ | ✓¹ | — | — |
| Confirmations: view | ✓ | ✓ | ✓ | ✓ |
| Confirmations: approve | ✓ | ✓ | — | — |
| MCP read tools | ✓ | ✓ | ✓ | ✓ |
| MCP write tools (propose) | ✓ | ✓ | ✓ | — |

¹ admin may manage operator/viewer/admin but **cannot** modify/remove an `owner` nor grant `owner`.

Dashboard rows = new `requireRole` gates (this phase). MCP rows = already enforced by `policies/engine` (role from DB) + the confirmation `required_approver_roles` (owner/admin) check — operator/viewer are naturally excluded from approval.

---

## 7. Users/Team page (`/dashboard/users`, owner+admin)

- **List** active users (email, role, status) + pending invitations (email, role, expiry).
- **Invite** (`POST /dashboard/users/invite`, email + role∈{admin,operator,viewer}): `email_has_user(email)` guard → reject if already a user anywhere; else insert `invitations` (random `token`, `expires_at = now()+7d`) → display the `/dashboard/accept?token=…` link **once** for the owner to share (email delivery deferred).
- **Change role** (`POST /dashboard/users/:id/role`): admin can't modify an owner or grant owner; **last-owner guard** — reject demoting the final owner.
- **Remove user** (`POST /dashboard/users/:id/remove`): same guards; soft-delete (`users.status='deleted'`) **and revoke that user's API keys** (`UPDATE api_keys SET revoked_at=now() WHERE created_by_user_id=$`); can't remove the last owner.
- **Revoke pending invite** (`POST /dashboard/invitations/:id/revoke`): **DELETE** the row (not expire — leaving `accepted_at IS NULL` would keep occupying the partial-unique-email slot and block re-inviting the same address). RLS-scoped so a tenant can only delete its own invites.
All CSRF'd, RLS-scoped, behind `requireRole('owner','admin')`.

---

## 8. Testing

- **Unit:** `requireRole` (allow/deny per role); last-owner guard helper (counting active owners; reject when demoting/removing would hit 0).
- **Integration (testcontainers):**
  - `resolve_or_provision_tenant` invite branch — an email with a pending invite returns `pending_invite` and does NOT create a tenant; an email without an invite still provisions.
  - `accept_invitation` — valid token+email joins the invited tenant with the role; wrong email → reject; expired → reject; already-accepted → reject; existing-subject → reject; concurrent accept (two calls) → exactly one user created.
  - `email_has_user` cross-tenant true/false.
  - Users page: invite (link shown, `email_has_user` rejects dupes) → accept → member appears with role; change-role (admin can't touch owner; last-owner-demote rejected); remove (status='deleted' + the user's api_keys revoked); revoke pending invite.
  - RBAC: a `viewer`/`operator` session is 403'd from `/dashboard/users`, policy, keys; `admin` allowed except owner-only surfaces (Openprovider creds).
- **E2E:** owner invites an `operator` → operator accepts via the token link (fake-WorkOS as the operator's email, with the email-match check) → operator's `/mcp` token proposes `register_domain` (allowed) but `confirm_pending` by the operator is rejected (`approver_role_required`) → the owner approves it (`confirm_pending` succeeds). The full cross-user propose→approve loop.

---

## 9. File structure

| File | Responsibility |
|---|---|
| `migrations/0012_invitations.sql` | invitations table + CREATE OR REPLACE resolve_or_provision_tenant (pending_invite branch) + accept_invitation + email_has_user |
| `src/db/schema.ts` (mod) | invitations mirror; resolve return adds `status` |
| `src/auth/tenant-resolver.ts` (mod) | handle the `status` column (`resolved` vs `pending_invite`) |
| `src/auth/accept-invitation.ts` (new) | `acceptInvitation(pool, token, subject, email)` + `emailHasUser(pool, email)` wrappers |
| `src/dashboard/session.ts` (mod) | session gains `role` + optional `pending`; `requireRole` preHandler |
| `src/dashboard/server.ts` (mod) | login callback handles `pending_invite` → /dashboard/accept; accept routes |
| `src/dashboard/routes/accept.ts` (new) | GET/POST accept |
| `src/dashboard/routes/users.ts` (new) | Users/Team page + invite/role/remove/revoke |
| `src/dashboard/routes/*.ts` (mod) | add `requireRole` gates per the matrix |
| `src/dashboard/views/{accept,users}.eta` (new) | templates |
| tests | per §8 |

---

## 10. Out of scope

- WorkOS Organizations / SCIM / SSO.
- Multi-tenant membership (one user = one tenant).
- Email delivery of invites (link shown in the UI).
- Ownership transfer (can't invite a 2nd owner; promoting to owner deferred).
- Per-user per-tool scope narrowing.

---

*End of spec.*

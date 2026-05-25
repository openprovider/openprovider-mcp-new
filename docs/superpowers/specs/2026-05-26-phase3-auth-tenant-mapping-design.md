# Phase 3 Auth — User→Tenant Mapping with JIT Provisioning — Design Spec

- **Status:** Approved (brainstormed 2026-05-26)
- **Scope:** The authentication claim-model only — how real WorkOS AuthKit tokens resolve to a tenant. The rest of Phase 3 (read tools, live-sandbox tests, `secrets/dek.ts` consolidation, per-principal rate limit, `tenant:onboard` CLI) is covered by the Phase 3 implementation plan, not this spec.
- **Resolves:** Phase 2 "Gap 2" — the verifier required an `act.tnt` claim and `mcp:*` scopes that real AuthKit tokens do not carry.
- **Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §5 (Layer 1).
- **Roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md` § Phase 3.

---

## 1. Decision context

The product's tenant model is **one WorkOS user = one tenant** (individual users, no WorkOS Organizations). This eliminated both roadmap options:

- **Option A (WorkOS Organizations → tenants)** — no organizations exist, so there is no `org_id` claim to map.
- **Option B (custom `act.tnt` claim + custom `mcp:*` scopes)** — possible but requires WorkOS JWT-template config and perpetuates a custom-claim dependency.

**Chosen model:** tenant identity derives from the user's stable WorkOS subject (`sub`). Each user maps 1:1 to a tenant via the `users.oauth_subject` column already created in Phase 1. On a user's first authenticated request, a tenant + user row are auto-provisioned (just-in-time). Role and tenant come from the database, not from token claims or scopes.

The cross-tenant lookup (find a user *by `oauth_subject`* when the tenant is not yet known) is confined to a single `SECURITY DEFINER` Postgres function — **Approach 1** from the brainstorm.

---

## 2. Claim model + verifier change

`createWorkOsVerifier` (in `src/auth/oauth/workos.ts`) changes:

- **Removes** the `act.tnt` requirement (it currently throws `OAuthVerificationError('missing act.tnt claim')`).
- Validates the token exactly as today: RS256, `issuer` = AuthKit domain, `audience` = client id, JWKS via the cached `createRemoteJWKSet`.
- Returns a narrowed shape:

```ts
interface VerifiedClaims {
  subject: string;   // the `sub` claim
  email: string;     // the `email` claim (AuthKit issues it; in scopes_supported)
  expiresAt: Date;
}
```

`scopes` and `tenantId` are removed from `VerifiedClaims` — they are no longer the verifier's concern. If `email` is absent (shouldn't happen with the `email` scope, but defensively), the verifier returns `email: ''` rather than throwing; identity resolution still works off `subject`.

Existing `workos.test.ts` updates: the "rejects token without act.tnt" test is replaced by an "accepts token without act.tnt, returns subject+email" test. Issuer/audience/expiry tests are unchanged.

---

## 3. `resolve_or_provision_tenant` — migration 0007 (`SECURITY DEFINER`)

A single Postgres function is the only cross-tenant-capable surface in the system.

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
    -- Fast path: existing user.
    RETURN QUERY
      SELECT u.tenant_id, u.id, u.role FROM users u WHERE u.oauth_subject = p_subject;
    IF FOUND THEN
      RETURN;
    END IF;

    -- Provision new tenant + owner user inside a subtransaction so that, if a
    -- concurrent first-login wins the users insert, BOTH inserts here roll back
    -- (no orphan tenant) and we loop to re-select the winner's row.
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
      -- Lost the race on users.oauth_subject; the subtransaction (including the
      -- tenants insert) is rolled back. Loop and re-select the existing row.
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION resolve_or_provision_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_provision_tenant(text, text) TO app_role;
```

Notes:
- `SECURITY DEFINER` runs as the function owner (migration superuser), so the cross-tenant `SELECT`/`INSERT` is not blocked by RLS. `search_path` is pinned to `public` — required for `SECURITY DEFINER` safety (prevents search-path injection).
- **Race handling:** the inner `BEGIN … EXCEPTION` block is a plpgsql subtransaction (implicit savepoint). If a concurrent first-login already inserted the user, this transaction's `INSERT INTO users` raises `unique_violation` on the `oauth_subject` unique constraint; the savepoint rolls back **both** the `tenants` and `users` inserts — leaving no orphan tenant — and the `LOOP` re-runs the fast-path select, which now finds the winner's row. Net invariant: exactly one tenant per subject, no orphans.
- `EXECUTE` is granted only to `app_role`; the function is not callable by `PUBLIC`.
- The integration test (§7) must include a concurrency case asserting both the single-tenant outcome **and** zero orphan `tenants` rows (a tenant with no matching user).

Migration journal entry `idx: 6, tag: 0007_resolve_or_provision_tenant`.

---

## 4. `auth/identity` rewrite

`IdentityResolverConfig` gains an optional `resolveTenant` dependency:

```ts
type TenantResolution = { tenantId: string; userId: string; role: 'owner'|'admin'|'operator'|'viewer' };
type TenantResolver = (subject: string, email: string) => Promise<TenantResolution>;

interface IdentityResolverConfig {
  devToken: string;
  devPrincipal: Principal;
  verifier?: AccessTokenVerifier;
  resolveTenant?: TenantResolver;   // calls resolve_or_provision_tenant
}
```

Resolver flow for a non-dev, non-API-key bearer:
1. `claims = await verifier(token)` → `{subject, email, expiresAt}`.
2. `resolution = await resolveTenant(claims.subject, claims.email)`.
3. Build the `Principal`:
   ```ts
   { kind: 'user', tenantId: resolution.tenantId, userId: resolution.userId,
     subject: claims.subject, scopes: [], role: resolution.role }
   ```
4. On verifier rejection → return `null` (→ 401), unchanged. On `resolveTenant` failure (DB error) → throw (→ 500), since it's not an auth failure.

`scopes` is now `[]` — authorization is role-based off the DB, not scope-based. The provisional `mcp:write → operator` mapping from Phase 2 is removed.

The dev-token and `op_live_` API-key branches are unchanged.

---

## 5. Composition + per-request flow

`src/server.ts` wires `resolveTenant` as a function that:
1. Acquires a short-lived pool client (on `app_role`).
2. Calls `SELECT * FROM resolve_or_provision_tenant($1, $2)` with `(subject, email)`.
3. Releases the client immediately.

This runs *before* the per-request tenant transaction. The existing `dispatchFactory(principal)` flow is unchanged: once `principal.tenantId` is known, it `BEGIN`s, `SET LOCAL ROLE app_role`, `set_config('app.current_tenant', tenantId, true)`, runs tools + audit, and commits. Two separate connections: one ephemeral for resolution, one transactional for the request body.

Concurrency: identity resolution does not hold the request transaction open, so the `SECURITY DEFINER` call can't deadlock with the request's RLS work.

---

## 6. "No Openprovider credentials" handling

A freshly provisioned tenant has `tenants` + `users` rows but **no** `openprovider_accounts` row and no stored `openprovider.password` secret.

- `openprovider/token-manager.fetchCredentials` (wired in `server.ts`) currently throws a generic `Error` when the account/password is missing. Phase 3 introduces a typed error `OpenproviderAccountNotConnected` (in `src/openprovider/errors.ts`).
- The dispatcher maps it to the structured client error code **`openprovider_not_connected`** with a message: `"No Openprovider account connected for this tenant. Run: openprovider-mcp tenant:onboard"`.
- This is a clean expected state (the user is authenticated, the tenant exists, they just haven't linked Openprovider yet), not a 500. The audit row records `event_type='tool.error'`, `error_code='openprovider_not_connected'`.

---

## 7. Test strategy

**Unit (`vitest`):**
- `workos.test.ts`: token without `act.tnt` now verifies successfully and returns `{subject,email}`; the old "rejects missing act.tnt" test is replaced.
- `identity.test.ts`: a verified token maps to a Principal via a faked `resolveTenant`; role comes from the resolution, `scopes` is `[]`.

**Integration (testcontainers Postgres):**
- `resolve_or_provision_tenant`: (a) first call provisions a tenant + owner user; (b) second call with the same subject returns the *same* `tenant_id`/`user_id`; (c) N concurrent calls with one subject yield exactly one tenant **and zero orphan tenants** (a `tenants` row with no matching `users` row); (d) RLS remains enforced for normal `app_role` queries — the function does not leak cross-tenant read access outside itself.

**E2E (extend Phase 2 `mcp/e2e.test.ts`):**
- A real-shaped AuthKit token (only `sub` + `email`, no `act.tnt`/`mcp:*`) authenticates → tenant auto-provisioned → `check_domain` returns `openprovider_not_connected`.
- Then seed `openprovider_accounts` + the encrypted password for that auto-provisioned tenant → `check_domain` succeeds against the Nock-mocked upstream.
- Cross-tenant isolation still holds: a second user provisions a distinct tenant; neither sees the other's audit rows.

---

## 8. What this spec deliberately excludes

- Real WorkOS dashboard config (DCR, Resource Indicators) — operator action, noted in the Phase 2 plan Task 1 and Phase 3 plan.
- The remaining read tools, `secrets/dek.ts` consolidation, per-principal rate limit, and `tenant:onboard` CLI — these are Phase 3 implementation-plan scope, following established Phase 2 patterns. They are not auth-model decisions.
- Org/team tenants — explicitly out of scope; revisit only if the product later adds B2B teams (would layer a WorkOS Organizations path alongside this user→tenant one).

---

*End of spec.*

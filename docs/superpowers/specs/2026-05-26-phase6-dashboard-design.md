# Phase 6 — API Keys + Single-Owner Dashboard — Design Spec

- **Status:** Approved (brainstormed 2026-05-26)
- **Scope (decomposed):** **(1)** the API-key authentication path — unblock the `op_live_` stub in `auth/identity` with an `api_keys` table + issuance + cross-tenant lookup; **(2)** a single-owner server-rendered dashboard (Fastify + eta + htmx, WorkOS hosted login) for credential onboarding, policy editing, API-key management, audit viewing, and confirmation approval.
- **Explicitly deferred to a later phase (6b):** multi-user invitation + full RBAC. Phase 6 treats the logged-in WorkOS user as the tenant's single owner.
- **Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §3 (`tenants/onboarding`), §4 (`api_keys`), §5 (RBAC, API keys).
- **Builds on:** Phases 1–5 + 7 (`feat/enterprise-phase-1`).

---

## 1. Decisions taken in brainstorming

1. **Decompose:** Phase 6 = API keys + single-owner dashboard; multi-user RBAC + invitation is a later phase.
2. **Fastify + server-rendered eta templates + htmx** — stays in the existing process; no SPA/separate build.
3. **WorkOS AuthKit hosted login + signed cookie session** for the dashboard, reusing the Phase 3 user→tenant resolver.
4. **Service-principal effective role:** an API key maps to `operator` if it has `mcp:write`, else `viewer`, for `policies/engine` decisions; a service principal can never be a confirmation approver.
5. **Shared credential-onboard helper** (`tenants/onboard-credentials.ts`) used by both the `tenant:onboard` CLI and the dashboard form so they don't drift.

---

## PART 1 — API-Key Authentication

## 2. `api_keys` table (migration 0011)

```sql
CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  prefix             text NOT NULL,
  hash               text NOT NULL,          -- argon2id of the full key
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
```

Journal entry `idx: 10, tag: 0011_api_keys`. `argon2` is a new dependency (memory 64 MB, iterations 3, per master spec §9).

> **Docker build risk:** `argon2` is a native (node-gyp) module. It usually installs a prebuilt binary for linux, but if the prebuilt is unavailable for the build image it needs `python3 make g++`. The plan must verify `docker build` still succeeds; if it fails, add `RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*` before `npm ci` in the build stage (the runtime distroless stage is unaffected — only compiled output is copied). If native build proves troublesome, `@node-rs/argon2` (Rust, prebuilt-first) is a drop-in fallback — note it as the escape hatch.

## 3. Key format + issuance

- Format: `op_live_<base64url(32 random bytes)>`. `prefix` = the first 12 chars (`op_live_` + 4 of the random part) for display/lookup.
- Issue: generate key → argon2id-hash the **whole** key → insert `{ prefix, hash, name, scopes }` under the tenant context → return the plaintext **once** (never stored, never re-shown).
- `scopes` default to the issuing owner's scopes (`['mcp:read','mcp:write']`); a future UI can narrow them.

## 4. Cross-tenant lookup — `resolve_api_key` (SECURITY DEFINER)

Authenticating a key requires finding it without knowing the tenant (mirrors Phase 3's `resolve_or_provision_tenant`). Migration 0011 adds:

```sql
CREATE FUNCTION resolve_api_key(p_prefix text)
  RETURNS TABLE (id uuid, tenant_id uuid, hash text, scopes text[], expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, hash, scopes, expires_at, revoked_at FROM api_keys WHERE prefix = p_prefix;
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO app_role;
```

Returns all candidates for a prefix (collisions are rare but handled by verifying each).

## 5. `auth/identity` — the `op_live_` branch

Replace the `throw new Error('API key authentication lands in phase 6')` with a real resolver, injected like the OAuth verifier:

```ts
export type ApiKeyResolver = (presentedKey: string) => Promise<Principal | null>;
// config gains: apiKeyResolver?: ApiKeyResolver
```

`createApiKeyResolver(pool)` returns a function that:
1. Computes `prefix` from the presented key (first 12 chars).
2. Calls `resolve_api_key(prefix)` on a short-lived `app_role` connection.
3. For each candidate, `argon2.verify(candidate.hash, presentedKey)`; on match:
   - reject if `revoked_at` set or `expires_at < now()` → return `null` (401).
   - best-effort `UPDATE api_keys SET last_used_at = now() WHERE id = $1` under the tenant context.
   - return `{ kind:'service', tenantId, apiKeyId: id, subject: 'apikey:'+id, scopes }`.
4. No match → `null`.

`auth/identity`'s `op_live_` branch calls this resolver (if configured) instead of throwing. The dev-token + OAuth branches are unchanged.

## 6. Service-principal effective role

`policies/engine` decisions are role-based. A service principal has `scopes` but no human role. In `server.ts`'s `dispatchFactory`, derive the effective role for a service principal: `scopes.includes('mcp:write') ? 'operator' : 'viewer'`. A service principal is **never** in any confirmation's `required_approver_roles` (those list human roles owner/admin), so `confirm_pending` by a service key is rejected with `approver_role_required` — keys can propose writes but a human must approve confirm-mode ops.

---

## PART 2 — Single-Owner Dashboard

## 7. Stack + session auth

- New module `src/dashboard/` mounted on the existing Fastify app under `/dashboard`.
- `@fastify/view` + **eta** templates (`src/dashboard/views/`), `@fastify/formbody`, `@fastify/cookie` (signed). htmx vendored as a static asset served by `@fastify/static`.
- **Login:** `/dashboard/login` → redirect to WorkOS AuthKit hosted login (authorization URL via `@workos-inc/node`); `/dashboard/login/callback` exchanges the code, resolves the WorkOS user → tenant via the existing Phase 3 `resolve_or_provision_tenant`, stores `{ tenantId, userId, subject }` in a signed session cookie. **Logout** clears it.
- `requireSession` preHandler guards `/dashboard/*` except login; on no/expired session → redirect to `/dashboard/login`. It opens the per-request RLS-scoped connection (BEGIN + `SET LOCAL ROLE app_role` + tenant GUC) the same way `/mcp` does, exposing it to the route handler, and commits/releases after.

## 8. Pages (tenant-scoped, single-owner)

| Route | Function |
|---|---|
| `GET /dashboard` | Overview: tenant id, Openprovider connection status, spend vs cap, counts |
| `GET/POST /dashboard/openprovider` | Form (username + password) → `onboardCredentials(...)` (shared helper §10) encrypts via `secrets/store` + upserts `openprovider_accounts` |
| `GET/POST /dashboard/policy` | Textarea of current policy JSON; save validates with `PolicyDoc` (zod) → `upsertPolicy`; inline errors on invalid JSON |
| `GET /dashboard/keys`, `POST /dashboard/keys/issue`, `POST /dashboard/keys/:id/revoke` | List (prefix/name/last_used/status); issue (plaintext shown once via htmx swap); revoke |
| `GET /dashboard/audit`, `GET /dashboard/audit/export` | Paginated audit table + filters (event_type, tool, time); NDJSON export (per-tenant, RLS) |
| `GET /dashboard/confirmations`, `POST /dashboard/confirmations/:id/approve` | Pending list via `list_pending_confirmations`; approve → `confirm_pending` consume path |

All rendered with a shared eta layout; htmx for the issue-key swap, revoke, and approve actions (partial re-render, no full SPA).

## 9. Error handling + safety

- Form validation errors render inline in the page (no 500). Invalid policy JSON → the textarea re-renders with the zod error message.
- Session-expired → redirect to login.
- Secrets never rendered: the Openprovider password field is write-only (never pre-filled); API keys shown exactly once at issue.
- All DB access via the RLS-scoped per-request connection; the dashboard cannot read another tenant's data.
- CSRF: state-changing POSTs include a per-session CSRF token (signed cookie + hidden field), validated in the preHandler.

## 10. Shared credential-onboard helper

Extract the encrypt+upsert logic (currently inline in `scripts/tenant-onboard.ts`) into `src/tenants/onboard-credentials.ts`:

```ts
export async function onboardCredentials(deps: {
  client: pg.PoolClient; kms: Kms; kmsKeyName: string;
}, input: { tenantId: string; username: string; password: string }): Promise<void>;
// upserts openprovider_accounts(username, status='connected') + secrets/store.put('openprovider.password')
```

`scripts/tenant-onboard.ts` and the dashboard `POST /dashboard/openprovider` both call it — single source of truth, no drift.

## 11. Testing

**Part 1 (API keys):**
- Unit: key format + argon2 verify (right key passes, wrong fails); service-principal effective-role mapping.
- Integration: `resolve_api_key` SECURITY DEFINER returns candidates cross-tenant; `createApiKeyResolver` authenticates a stored key, rejects revoked/expired; RLS still scopes `api_keys` reads.
- E2E: issue a key via the dashboard endpoint → authenticate `/mcp` with `Bearer op_live_…` → `check_domain` works; revoked key → 401.

**Part 2 (dashboard):**
- Unit: `requireSession` (valid → context; missing/expired → redirect); policy-form bad-JSON → inline error; CSRF token check.
- Integration (testcontainers): with a faked session — Openprovider form encrypts+persists (ciphertext in `tenant_secrets`); policy save round-trips; key issue→list→revoke; audit page renders tenant-scoped rows; approve-confirmation drives `confirm_pending`.
- E2E: fake-WorkOS session cookie → `/dashboard` loads → issue key → authenticate `/mcp` with it (ties Part 1 + 2).
- No pixel/visual tests — utilitarian admin UI.

## 12. File structure

| File | Responsibility |
|---|---|
| `migrations/0011_api_keys.sql` (new) | api_keys table + resolve_api_key SECURITY DEFINER |
| `src/db/schema.ts` (mod) | apiKeys mirror |
| `src/auth/api-key.ts` (new) | `createApiKeyResolver(pool)` + issuance helpers (format, argon2 hash) |
| `src/auth/identity.ts` (mod) | op_live_ branch calls the resolver |
| `src/tenants/onboard-credentials.ts` (new) | shared encrypt+upsert helper |
| `scripts/tenant-onboard.ts` (mod) | use the shared helper |
| `src/dashboard/server.ts` (new) | mounts routes, session, view engine on the Fastify app |
| `src/dashboard/session.ts` (new) | cookie session + requireSession preHandler + CSRF |
| `src/dashboard/routes/*.ts` (new) | one file per page group |
| `src/dashboard/views/*.eta` (new) | layout + page templates |
| `src/server.ts` (mod) | wire apiKeyResolver + mount the dashboard; service-principal effective role |
| `package.json` (mod) | + argon2, @fastify/view, eta, @fastify/cookie, @fastify/formbody, @fastify/static |
| tests | per §11 |

## 13. Out of scope (Phase 6b+)

- Multi-user invitation + full RBAC (single-owner only here).
- SSO/SAML/SCIM.
- Dashboard theming / real-time updates / pixel-level design.
- Narrowing API-key scopes in the UI (keys inherit owner scopes for now).

---

*End of spec.*

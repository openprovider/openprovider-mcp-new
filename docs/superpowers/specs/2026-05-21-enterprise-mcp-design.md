# Enterprise-Ready Openprovider MCP — Design Spec

- **Status:** Draft v1
- **Date:** 2026-05-21
- **Scope:** Design only. No implementation in this round.
- **Successor to:** the current single-file stdio MCP server at `server.js` / `src/server.ts`.

---

## 1. Goals, non-goals, scope

### Goals (v1)

- Multi-tenant SaaS MCP server fronting the Openprovider REST API.
- Tenant identity via **OAuth 2.1** (MCP spec-compliant) with **API keys** for service accounts.
- Per-tenant Openprovider credentials onboarded via dashboard, **encrypted at rest** (KMS envelope), refreshed automatically.
- **Streamable HTTP** transport, compatible with current Claude / ChatGPT connectors.
- Read tools available immediately; write tools (register / update / delete) require a **confirmation workflow** gated by per-tenant policies (spend caps, TLD allowlist, approver list).
- **SOC 2-ready** posture from day one: structured logs, OpenTelemetry traces / metrics, immutable audit log, RBAC, change-management hooks.
- Single-region deploy on managed infra (managed Postgres + cloud KMS + container runtime). **Default region: EU.**

### Non-goals (v1)

- Multi-region / active-active.
- SAML / SCIM SSO (OIDC federation deferred to a later version).
- Billing / metering as a revenue surface.
- Reselling Openprovider on a shared account (tenants always BYO Openprovider).
- Domain features beyond Openprovider's current API (no DNS hosting, no SSL, etc.).
- Long-lived refresh of OAuth client registrations (DCR is supported; lifecycle UI is minimal).
- Formal SOC 2 *certification* — design is audit-ready; the audit itself is out of scope.

### Scope of this spec

The design and the implementation plan that follows it. No code in this round.

---

## 2. High-level architecture

One deployable service ("openprovider-mcp") with three HTTP surfaces, talking to managed Postgres + cloud KMS + an OpenTelemetry collector, with workers running in the same image.

```
                    ┌─────────────────────────────────────────────────┐
                    │                  openprovider-mcp                │
                    │  (Node/TypeScript, single container, N replicas) │
                    │                                                  │
  MCP client ──────►│  /mcp        Streamable HTTP MCP endpoint       │
  (Claude, etc.)    │              ├─ AuthN: OAuth bearer / API key   │
                    │              ├─ Tool dispatch + policy gate     │
                    │              └─ Confirmation flow for writes    │
                    │                                                  │
  Browser ─────────►│  /dashboard  Tenant onboarding UI               │
                    │              ├─ Openprovider cred onboarding   │
                    │              ├─ Policy editor                  │
                    │              ├─ Audit log viewer               │
                    │              └─ API key issuance               │
                    │                                                  │
  MCP client / ────►│  /oauth/*    OAuth 2.1 surface                  │
  Browser           │              (delegated to WorkOS)               │
                    │                                                  │
                    │  workers     ├─ Openprovider token refresh      │
                    │              ├─ Audit log flush → object store  │
                    │              └─ Confirmation token expiry       │
                    └──────────────┬──────────────┬────────────────────┘
                                   │              │
                       ┌───────────▼──┐  ┌────────▼─────────┐  ┌───────────────┐
                       │  Postgres    │  │  Cloud KMS       │  │ OTel collector│
                       │  (managed)   │  │  (envelope key)  │  │ → logs/traces │
                       └──────────────┘  └──────────────────┘  │   /metrics    │
                                                                └───────────────┘
                                                  │
                                                  ▼
                                     ┌──────────────────────┐
                                     │  Openprovider API    │
                                     │  api.openprovider.eu │
                                     └──────────────────────┘
```

**Key shapes:**

- One Node/TypeScript process; multiple HTTP routers mounted in the same app. Workers run as `--mode=worker` on the same image so deploys are atomic.
- All persistent state in Postgres. Secrets stored as ciphertext columns; data keys wrapped by KMS CMK.
- Per-tenant Openprovider JWT cached in memory with a Postgres-backed fallback so replicas can share a refreshed token without thundering-herd.
- No direct calls from `/mcp` to Openprovider without going through a per-tenant token manager (rotation + 401 retry).
- Tool execution flows through a policy gate before the upstream call; writes additionally require a valid confirmation token bound to the tool arguments.
- **OAuth authorization server: WorkOS** (primary). Ory Hydra is the documented self-hosted fallback if WorkOS becomes unsuitable.

---

## 3. Components

Each module has one purpose and a defined interface. Module names are TypeScript module-shaped.

| # | Module | Purpose |
|---|---|---|
| 1 | `mcp/transport` | Streamable HTTP server; session IDs, SSE streaming, `Mcp-Session-Id` headers. No business logic. |
| 2 | `auth/identity` | Resolve "who is this request" once per call. Validates OAuth bearers (introspection) and API keys (argon2 verify). Output: typed `Principal`. |
| 3 | `auth/oauth` | Thin adapter around WorkOS. DCR pass-through, authorization-code + PKCE, token introspection. Single interface so we can swap IdPs. |
| 4 | `tenants/onboarding` | Server-rendered dashboard + APIs: tenant create, user invitation, Openprovider credential capture, API-key issuance / rotation. |
| 5 | `secrets/store` | Envelope-encrypted secret CRUD. Per-tenant DEK, KMS-wrapped. `put` / `get`. Plaintext never leaves the module's callers. |
| 6 | `openprovider/client` | Typed Openprovider API client. Generated from OpenAPI where possible, zod schemas elsewhere. Knows nothing about tenants. Retry / backoff lives here. |
| 7 | `openprovider/token-manager` | Per-tenant Openprovider session lifecycle: login, refresh, 401 retry, in-flight singleflight, in-memory + Postgres backstop. Output: `getToken(tenantId)`. |
| 8 | `policies/engine` | Per-tenant authorization: `{tool, args, principal, policy} → allow | deny | requires_confirmation`. JSON policies, no DSL. |
| 9 | `confirmations` | Two-phase write-op flow. `propose` mints a content-bound, single-use token; `consume` verifies + marks used. |
| 10 | `mcp/tool-dispatch` | Orchestrate a tool call: validate → policy gate → confirmation flow → token-manager → client → audit. |
| 11 | `audit/log` | Append-only `audit_events` insert (same DB txn as action) + hash chain + async flush to object storage with object-lock. |
| 12 | `observability` | OTel tracer / meter / logger setup. Sensitive-field redaction list (single source of truth). |
| 13 | `workers` | Background jobs (pg-boss, single queue). Concrete jobs and cadences: `openprovider.token.refresh` (per-tenant, scheduled at `token_expires_at - 5 min`); `audit.flush` (every 5 min); `audit.partition.seal` (daily at 02:00 UTC, seals previous day's partitions where complete); `confirmations.expire` (every 60 s — scans `confirmations` with `expires_at < now() AND consumed_at IS NULL`, releases linked reservations); `idempotency.expire` (every 5 min — deletes rows where `expires_at < now()`); `spend_window.recompute` (every 15 min and at window boundary — sums committed reservations into `policies.spend_caps.current_eur`, archives historical windows); `apikeys.cascade_revoke` (synchronous, triggered by user deletion). |

**Module dependency direction (no cycles):**

```
mcp/transport
  → auth/identity
       → mcp/tool-dispatch
            → policies/engine
            → confirmations
            → openprovider/token-manager → secrets/store
            → openprovider/client

audit/log, observability — leaf utilities consumed everywhere.
```

---

## 4. Data model

Postgres, single schema. All tenant-scoped tables enforce `tenant_id` via row-level security as defense-in-depth. Times are `timestamptz`. PII columns are annotated.

```
tenants
  id (uuid pk), name, status ['active'|'suspended'|'deleted']
  created_at, updated_at

users
  id (uuid pk), tenant_id (fk)
  email* (unique per tenant)
  oauth_subject               -- WorkOS user id
  role ['owner'|'admin'|'operator'|'viewer']
  created_at, last_login_at, status

tenant_keys                          -- one DEK per tenant
  tenant_id (pk, fk)
  wrapped_dek (bytea)                -- KMS-wrapped data key
  kms_key_arn                        -- which CMK wrapped it
  created_at, rotated_at

tenant_secrets
  id (uuid pk), tenant_id (fk)
  name                               -- e.g. 'openprovider.password'
  ciphertext (bytea), nonce (bytea), auth_tag (bytea)
  version                            -- monotonic, supports rotation
  created_at, rotated_at
  UNIQUE (tenant_id, name)

openprovider_accounts
  tenant_id (pk, fk)
  username*, reseller_id
  cached_token (bytea)               -- ciphertext of current JWT (optional)
  token_expires_at
  status ['connected'|'invalid_credentials'|'rate_limited']
  last_verified_at

api_keys
  id (uuid pk), tenant_id (fk)
  prefix                             -- displayed; first 8 chars
  hash                               -- argon2id of full key
  name, created_by_user_id, last_used_at
  scopes (text[]), expires_at, revoked_at

oauth_clients
  id (uuid pk, also client_id)
  tenant_id (fk, nullable)           -- null = global / official
  client_secret_hash                 -- nullable for public clients
  redirect_uris (text[]), grant_types (text[])
  registered_at, last_used_at

policies
  tenant_id (pk, fk)
  doc (jsonb)                        -- see policy shape below
  version (monotonic)
  updated_at, updated_by_user_id

confirmations
  id (uuid pk), tenant_id (fk)
  principal_subject                  -- who proposed it
  tool_name
  args_hash (bytea)                  -- sha256(canonical(args) || tenantId)
  args_jsonb (jsonb, redacted)       -- redacted copy so approvers can render diff
  summary_text                       -- the human-readable proposal summary
  estimated_cost_eur                 -- captured at proposal time; null for non-billable
  required_approver_roles (text[])
  created_at, expires_at
  consumed_at                        -- null = pending; set on use
  INDEX (tenant_id, expires_at)
  PARTIAL UNIQUE INDEX (id) WHERE consumed_at IS NULL

spend_reservations                   -- atomic spend-cap accounting (see §6)
  id (uuid pk), tenant_id (fk)
  confirmation_id (fk, nullable)     -- null only for "manual debit" admin actions
  amount_eur (numeric(12,4))
  status ['pending'|'committed'|'released']
  window_start                       -- truncated to policies.spend_caps.window
  created_at, settled_at
  INDEX (tenant_id, window_start, status)

idempotency_records
  tenant_id (fk), key
  tool_name, result_json, created_at
  expires_at                         -- 10 min from create; swept by worker
  PRIMARY KEY (tenant_id, key)
  INDEX (expires_at)

audit_events                         -- append-only; DELETE/UPDATE revoked
  id (bigserial pk), occurred_at
  tenant_id (fk)
  actor_kind ['user'|'service'|'system'], actor_subject
  event_type                         -- 'tool.call', 'tool.denied', ...
  tool_name (nullable)
  resource_type, resource_id
  request_args (jsonb, redacted)
  result (jsonb, redacted)
  http_status, error_code
  trace_id, span_id
  prev_hash (bytea), row_hash (bytea)
  PARTITIONED BY RANGE (occurred_at) -- monthly

audit_archives                       -- pointer to object-store flush
  tenant_id (fk), partition_name, object_url, sealed_at, sha256
```

### Policy document shape

```jsonc
{
  "version": 1,
  "spend_caps": {
    "window": "month",
    "limit_eur": 500,
    "current_eur": 87.20             // updated by workers
  },
  "tld_allowlist": [".com", ".net", ".io"],
  "tld_denylist": [".xxx"],
  "tools": {
    "register_domain": { "mode": "confirm", "approvers": ["owner","admin"] },
    "delete_contact":  { "mode": "confirm", "approvers": ["owner"] },
    "check_domain":    { "mode": "allow" },
    "list_*":          { "mode": "allow" }
  },
  "ip_allowlist": []                 // empty = no restriction
}
```

### Audit hash chain

`row_hash = sha256(prev_hash || canonical_jsonb(row))`. `prev_hash` for row N is row N-1's `row_hash` within the same monthly partition. A genesis row per partition closes the chain. The async flusher writes monthly partitions to object storage with object-lock + retention.

### Row-Level Security

Every tenant-scoped table has an RLS policy:

```sql
USING (tenant_id = current_setting('app.current_tenant')::uuid)
```

The DB connection sets that GUC immediately after `auth/identity` resolves the principal. The app role cannot bypass RLS; only the migration role can.

### PII handling in audit rows

`request_args` and `result` are stored with a redaction list applied (passwords, full SSN-equivalents) but leave non-sensitive fields visible so the log is debuggable.

**Field-level classification:**

| Class | Examples | Audit row | Logs / traces |
|---|---|---|---|
| Secret | passwords, tokens, ciphertexts, KMS material, API-key values | `[REDACTED]` | `[REDACTED]` |
| Strong PII | full SSN/INN, birth date, social security number | `[REDACTED]` | `[REDACTED]` |
| Contact PII (kept-visible for debuggability) | name, email, phone, postal address | stored as-is | first 2 chars + `…` (e.g. `jo…@example.com`) |
| Operational | domain names, contact ids, handles, tool names, status codes | stored as-is | stored as-is |

The boundary is explicit in `observability/classify.ts` — every field used in any tool's input or output is annotated, and a unit test asserts that the union of all annotated fields equals the union of all field paths the zod schemas can produce. Schema drift breaks the test.

### Sessions / refresh tokens

WorkOS owns session state entirely; no `sessions` table in our DB. The audit log still records each MCP call.

---

## 5. Authentication & authorization

Two layers, never conflated.

### Layer 1 — Tenant → MCP

**OAuth 2.1 (humans + interactive clients)**

- Authorization server: WorkOS.
- The MCP server publishes `/.well-known/oauth-protected-resource` so spec-aware clients (Claude, ChatGPT, MCP Inspector) auto-discover the IdP.
- Scopes: `mcp:read`, `mcp:write`, `dashboard:admin`. The dashboard issues consent for `mcp:*` scopes during initial connection.
- Token lifetimes: access ~15 min, refresh ~30 days.

**API keys (service accounts / automation)**

- Issued from the dashboard by `owner` or `admin` users. Format: `op_live_<32 random bytes b64url>`.
- Displayed once; we store **argon2id hash** (memory 64 MB, iterations 3) + a `prefix` for debugging.
- Sent as `Authorization: Bearer op_live_…`. The `auth/identity` module distinguishes by prefix.
- Keys carry a `scopes[]` subset of the issuing user's scopes.

**Principal object** — single typed result downstream code consumes:

```ts
type Principal =
  | { kind: 'user';    tenantId; userId; subject; scopes; role }
  | { kind: 'service'; tenantId; apiKeyId; subject; scopes }
```

**RBAC roles**

- `owner` — full control; only role that can rotate Openprovider credentials; unrestricted audit log access.
- `admin` — manage users, policies, API keys; cannot rotate Openprovider credentials.
- `operator` — call any tool the policy allows (read + write).
- `viewer` — read tools only.

Scope-to-tool mapping lives in `policies/engine`, not in the transport.

**Dashboard session auth**

WorkOS hosted login UI; cookie-session managed by WorkOS, validated server-side on each request. No password reset, MFA, or lockout logic in our codebase.

### Layer 2 — MCP → Openprovider

Handled exclusively by `openprovider/token-manager`. Nothing else touches Openprovider auth.

- On first tool call for a tenant: fetch ciphertext from `secrets/store`, decrypt via tenant DEK, POST `/auth/login`, persist returned JWT + expiry in `openprovider_accounts.cached_token` (also encrypted), keep an in-memory copy.
- Subsequent calls: in-memory cache hit → return token. Cache miss → check Postgres → if still valid, hydrate cache; else refresh.
- **Singleflight**: concurrent refreshes for the same tenant collapse to one in-flight request via a per-tenant async mutex.
- **401 retry**: one transparent retry that forces a fresh login.
- **Failure modes** surface as typed errors that flow back to the MCP client *without* exposing Openprovider's auth response: `OpenproviderCredentialsInvalid`, `OpenproviderRateLimited`, `OpenproviderUnavailable`. The first sets `openprovider_accounts.status='invalid_credentials'` and triggers a dashboard notification.

### Defense-in-depth

- DB connection sets `SET app.current_tenant = '<uuid>'` immediately after authN; RLS denies anything else.
- All routes except `/oauth/*`, `/healthz`, `/.well-known/*`, `/dashboard/login` require an authenticated principal.
- Per-principal rate limits — defaults **60 reads/min, 10 writes/min**, surfaceable in policy.
- IP allowlist enforcement at the policy layer when `policies.ip_allowlist` is non-empty.
- Secrets never logged. Redaction list in `observability` is the single source of truth.
- **Result-size cap (prompt-injection mitigation):** every tool response is capped at **256 KB** of JSON post-redaction; reads exceeding the cap return `result_too_large` and must be re-issued with narrower filters or pagination. Tools that intrinsically return PII (`list_contacts`, `get_contact`) are also rate-limited per principal at **20 calls / hour** by default. The intent is to make bulk PII exfiltration via a compromised or prompt-injected LLM noisy and slow.
- **API key scopes on role change:** a key's `scopes[]` are checked at every request against the issuing user's *current* scopes. When the issuing user's role is reduced, requests via the key are evaluated under the *intersection* of the key's scopes and the user's current scopes — silent narrowing, not revocation. When the issuing user is deleted/disabled, every key they issued is automatically revoked (`api_keys.revoked_at = now()`) by a synchronous trigger.
- **Global OAuth clients** (`oauth_clients.tenant_id IS NULL`) — used only by the dashboard and an "official" Claude/ChatGPT connector. A global client's session never resolves to a tenant by itself; the user's WorkOS authenticated identity (`oauth_subject`) is looked up in `users` and the unique `tenant_id` for that row supplies tenant context. If a user belongs to multiple tenants, the OAuth consent step requires explicit tenant selection and stamps `tenant_id` into the issued access token's `act.tnt` claim; the MCP transport rejects tokens without it.

---

## 6. Tool surface and confirmation flow

### Tool catalogue (v1)

| Tool | Effect | Mode (default policy) | Notes |
|---|---|---|---|
| `check_domain` | read | `allow` | Paginated batching server-side |
| `list_domains` | read | `allow` | |
| `get_domain` | read | `allow` | |
| `list_contacts` | read | `allow` | |
| `get_contact` | read | `allow` | |
| `register_domain` | **write (billable)** | `confirm` | Requires confirmation token + spend-cap check |
| `update_domain` | write | `confirm` | Nameservers, autorenew, dnssec |
| `delete_contact` | write (destructive) | `confirm` | |
| `create_contact` | write | `allow` (configurable to `confirm`) | Non-billable but stores PII |
| `update_contact` | write | `confirm` | |
| `list_pending_confirmations` | read | `allow` | Filtered to caller's approver roles |
| `confirm_pending` | meta | gated by confirmation's `required_approver_roles` | Cross-principal approval handoff |

**Removed from current code:**

- `login` tool — auth is implicit per principal.
- Silent India-specific phone-number formatting — caller supplies correctly-shaped data; we validate, we don't mutate.

**Schemas:** per-tool zod schemas replace the hand-rolled JSON schemas. Schemas live in `openprovider/client` and are re-exported as MCP `inputSchema`. Single source of truth, no drift.

### Confirmation flow (`mode: confirm` tools)

Two-phase, content-bound, single-use. Default TTL 5 min (configurable per tenant).

**Phase 1 — propose.** Client calls the write tool with `{ ...args, confirm: null }`.

Dispatcher (in a single Postgres transaction):

1. Validates args via zod.
2. Prices the operation (see *Pricing* below). For non-billable tools, `estimated_cost_eur = 0`.
3. `SELECT … FOR UPDATE` on the tenant's `policies` row to serialize concurrent spend-cap checks.
4. Computes `committed = current_eur` plus `SUM(amount_eur)` of `spend_reservations` rows where `status = 'pending'` and `window_start = current_window`. Adds `estimated_cost_eur`.
5. Runs `policies/engine`: role/scope, TLD lists, **`committed + estimated_cost_eur ≤ spend_caps.limit_eur`**.
6. If denied → returns a structured `policy_denied` error.
7. If allowed → inserts the `confirmation` row (with `args_hash`, `summary_text`, `args_jsonb`, `estimated_cost_eur`, `required_approver_roles`) **and** a `spend_reservations` row (`status='pending'`, `amount_eur=estimated_cost_eur`) in the same transaction. Both rows are linked by `confirmation_id`.
8. Commits and returns:

```json
{
  "status": "confirmation_required",
  "tool": "register_domain",
  "summary": "Register example.com for 1 year (€12.99). Spend cap: €87.20 committed of €500 (this proposal: €12.99).",
  "diff": { "domain": "example.com", "period": 1, "estimated_cost_eur": 12.99 },
  "confirmation_id": "cf_01HXY...",
  "confirmation_token": "ct_01HXY...",
  "required_approver_roles": ["owner","admin"],
  "expires_at": "2026-05-21T01:25:30Z"
}
```

`confirmation_id` is the stable surrogate for cross-principal approver handoff; `confirmation_token` is opaque, single-use, and bound to `args_hash`.

**Phase 2 — confirm + execute.** A principal whose role intersects `required_approver_roles` re-calls the same tool with `{ ...args, confirm: { token: "ct_01HXY..." } }`. The confirming principal can be the original proposer (when their own role satisfies `required_approver_roles`) or any approver.

Dispatcher (in a single Postgres transaction):

1. Loads the `confirmation` row by token-derived id (or `confirmation_id` when called via `confirm_pending`). Missing/unknown id → `confirmation_not_found`. Recomputes `args_hash`, verifies hash matches (`validation_failed` on mismatch), `consumed_at IS NULL` and `expires_at > now` (`confirmation_expired` otherwise), and the caller's role ∈ `required_approver_roles` (`approver_role_required` otherwise).
2. **Re-prices** the operation against the upstream (see *Pricing*) and asserts `new_price ≤ estimated_cost_eur × 1.05` (5% drift tolerance, configurable). Larger drift returns `price_changed` and the proposal must be re-issued. This protects the budget from premium/promo timing windows.
3. Marks `confirmation.consumed_at = now()` and flips the linked `spend_reservations` row to `status='committed'` with `settled_at = now()`. The async spend-cap recompute worker collapses committed reservations into `policies.spend_caps.current_eur` at window boundaries; until then the live spend is `current_eur + SUM(committed reservations in window)`.
4. Executes the Openprovider call. Idempotency key = `confirmation.id` (sent as header where Openprovider supports it; recorded locally either way).
5. On upstream **failure**: reservation flips to `status='released'` (the money was never spent). On upstream **success**: reservation stays `committed`.
6. Records `audit_events` rows for both the proposal and the execution, linked by `confirmation_id`.

**Reservation lifecycle:**
- Expired confirmations (TTL pass without consume) → worker flips reservation to `released` and records audit event.
- Released reservations free their amount from the live-spend calculation immediately.
- Workers reconcile `policies.spend_caps.current_eur` at window boundaries by summing committed reservations and resetting.

**Why content-bound:** the LLM cannot smuggle different args between proposal and execution — any change invalidates the hash. The dashboard's approval UI surfaces the exact diff to a human approver.

### Pricing

Pricing is *advisory* at proposal time and *authoritative* at consume time. The 5% drift guard ensures the approver's decision is not invalidated by silent upstream price moves while still preventing budget overrun via stale cache.

- **Standard TLDs:** dry-run via `check_domain` with `with_price: true`. Cached per `(TLD, period, currency)` for 24 h.
- **Premium domains:** when the proposal targets a domain Openprovider classifies as premium (response carries `is_premium=true`), the cache is bypassed; every proposal and every consume re-queries the live price.
- **Currency:** v1 prices are EUR only. The cache key includes `currency='EUR'`. If the upstream returns a non-EUR price for a TLD we do not convert — we surface `unsupported_currency` and abort. Conversion is deferred.
- **Promotions:** Openprovider returns promo pricing inside `check_domain` responses; the 24h cache window means a promo can expire mid-confirmation. The consume-time re-price + 5% drift guard catches this.
- **Non-billable confirm-mode tools** (`delete_contact`, `update_contact`): `estimated_cost_eur = 0` and the spend-cap check is skipped; the reservation row is still created with amount 0 for symmetry.

### Approver workflow handoff

When `tools[name].approvers` lists roles other than the caller's, the original proposer cannot self-confirm. Two MCP tools support cross-principal handoff:

| Tool | Effect | Available to |
|---|---|---|
| `list_pending_confirmations` | read | any principal; results filtered to confirmations where the caller's role ∈ `required_approver_roles` |
| `confirm_pending` | executes a previously-proposed confirmation | any principal whose role ∈ the confirmation's `required_approver_roles` |

`list_pending_confirmations` returns `confirmation_id`, `tool_name`, `summary_text`, `args_jsonb` (redacted for the approver's role), `estimated_cost_eur`, `proposer_subject`, `created_at`, `expires_at`. No tokens are returned by this tool — approvers fetch the canonical token via `confirm_pending`.

`confirm_pending(confirmation_id, args)` recomputes the args hash against the supplied args, looks up the stored token internally, and executes the same Phase-2 path. The dashboard's "Approve & execute" UI is a thin wrapper that calls `confirm_pending` with the args it rendered for the approver — so the approver's UI and any agentic approver share one code path. The args supplied by the approver must hash-match the original proposal; the LLM cannot smuggle different args at confirmation time even when it is the approver.

Out-of-band approval (dashboard) is the default UX; an approver-side agent loop is supported by the same tools. No inline "wait for approval" stream is exposed in v1 — confirmations are always separate calls, separate sessions, separate audit rows.

### Idempotency

Sources, in priority order:

1. Confirmation flow: `idempotency_key = confirmation.id`.
2. Client-supplied `idempotency_key` argument.
3. Auto-generated from `sha256(canonical(args) || tenantId || tool)` for `allow`-mode writes, with a 10-minute dedup window.

Storage: `idempotency_records` table. On hit, the stored `result_json` is returned without executing.

On the wire to Openprovider: pass our `idempotency_key` as a request header where their API supports it; otherwise the local table catches client-side replays.

### Error contract

```ts
{
  code: 'policy_denied' | 'confirmation_required' | 'confirmation_expired'
       | 'confirmation_not_found' | 'approver_role_required'
       | 'price_changed' | 'unsupported_currency'
       | 'result_too_large' | 'validation_failed'
       | 'openprovider_invalid_credentials'
       | 'openprovider_rate_limited' | 'openprovider_unavailable'
       | 'upstream_error',
  message: string,            // safe to surface to LLM
  details?: object,           // structured, no PII, no upstream tokens
  trace_id: string
}
```

---

## 7. Error handling, retries, idempotency

### Error taxonomy

| Client-visible code | Internal error class | Retryable? |
|---|---|---|
| `validation_failed` | `ValidationError` | no |
| `unauthenticated` / `policy_denied` | `AuthError` / `PolicyError` | no |
| `confirmation_required` / `confirmation_expired` | `ConfirmationError` | no (re-propose) |
| `openprovider_invalid_credentials` | `OpenproviderAuthError` | no (notify) |
| `openprovider_rate_limited` | `OpenproviderRateLimitError` | yes (backoff) |
| `openprovider_unavailable` | `OpenproviderUnavailableError` | yes (backoff) |
| `upstream_error` | `OpenproviderClientError` | no (caller fixes) |
| `internal_error` | unknown | no |

Errors are constructed at the layer that knows their semantics. No stringly-typed `new Error("foo")` on the request path.

### Retry policy

Two places only.

**`openprovider/client`** (per HTTP request):

- 5xx + network: up to 3 attempts; exponential backoff 250 ms, 1 s, 4 s + ±20% jitter; cap 5 s.
- 429: respect `Retry-After`; up to 2 attempts; missing header → backoff like 5xx.
- 401: **one** transparent retry that forces a token-manager refresh.
- 4xx (other than 401/429): never retry.
- Connection timeout 10 s connect / 30 s read; total budget per call 60 s including retries.

**`workers`** (per job):

- pg-boss exponential backoff, up to 5 retries over ~10 min, then dead-letter for human review.
- Token-refresh job has a smaller window (3 retries / ~30 s) and pages on dead-letter.

Nowhere else.

### Circuit breaker

`openprovider/client` wraps each endpoint in a circuit breaker:

- Open after 50% failure over a 30 s window with at least 20 requests.
- Half-open probe after 30 s.
- While open: fast-fail with `OpenproviderUnavailableError`. Status surfaces on `/healthz` and the dashboard.

### Timeouts

```
HTTP server request timeout         : 90s
  tool dispatch budget              : 75s
    Openprovider client call        : 60s (incl. retries)
      single attempt                : 30s read / 10s connect
```

### Audit + tracing on errors

Every error path emits an `audit_events` row when a tool was invoked (event_type `tool.error`) and a span with `error=true`, `error.kind`, `error.code`, linked via `trace_id` in the client-visible response.

### Fixes vs the current code

- `validateStatus: status < 500` — replaced by per-status mapping; 4xx is never silently treated as success.
- `processContactData` silent defaulting (`role: 'tech'`, `is_active: true`) — removed; schemas reject missing required fields.
- Raw upstream error messages — replaced by sanitized structured codes; raw details captured only in spans + audit log.

---

## 8. Observability & audit logging

### OpenTelemetry

Initialized once in `observability/`; everything else uses standard `@opentelemetry/api`.

**Traces.** Root span on every inbound HTTP request, propagated through `mcp/transport → auth/identity → mcp/tool-dispatch → policies/engine → openprovider/token-manager → openprovider/client`, plus DB queries and worker jobs.

Standard attributes: `tenant.id`, `principal.kind`, `principal.subject`, `tool.name`, `mcp.session_id`. **Never** as attributes: passwords, tokens, ciphertext, full contact PII.

**Metrics.**

- `mcp.tool.calls{tool, tenant, status}` — counter
- `mcp.tool.duration{tool}` — histogram
- `mcp.confirmations{tool, outcome}` — counter (`proposed | consumed | expired`)
- `openprovider.requests{endpoint, status_class}` — counter
- `openprovider.duration{endpoint}` — histogram
- `openprovider.circuit_state{endpoint}` — gauge
- `policies.evaluations{outcome}` — counter
- `secrets.kms_calls{operation}` — counter
- `audit.events_lag_seconds` — gauge
- `workers.jobs{queue, status}` — counter; `workers.queue_depth{queue}` — gauge

Cardinality: `tenant.id` is allowed on traces / logs, **not** on metrics. Tenant breakdowns happen by querying logs.

**Logs.** Structured JSON via pino. Every line carries `trace_id`, `span_id`, `tenant.id`, `principal.subject` (via AsyncLocalStorage). The redaction list in `observability/redact.ts` is the single source of truth:

```
password, client_secret, api_key, authorization, cookie,
data.token, wrapped_dek, ciphertext, plaintext, refresh_token,
contact.password, contact.social_security_number, contact.inn
```

Default level `info`; `debug` opt-in per tenant via dashboard (expires after 1 h).

**Export.** OTLP/gRPC to a collector running as sibling container. The service stays vendor-neutral.

**Sampling.** Head-sample traces at 10%, always keep errors and slow requests.

### Audit log

**What gets recorded.**

- Every `tools/call` attempt — proposal, denial, confirmation, execution, error.
- Every credential lifecycle event — Openprovider credentials added / rotated / invalidated, API key issued / rotated / revoked.
- Every policy change — `policies.doc` updated with diff.
- Every user lifecycle event.
- Tenant administrative actions.
- Configuration changes that affect security posture (e.g. IP allowlist edits).

Ordinary read tool calls beyond a counter are **not** in the audit log by default. A per-tenant flag enables full read auditing.

**Write path.**

1. Synchronous: inside the same DB transaction as the action, insert into `audit_events`. Sealed before the response leaves the process.
2. Hash chain over `(prev_hash, canonical(row))`. Genesis row per monthly partition.
3. Append-only at the DB layer: app role has `INSERT, SELECT` on `audit_events`; `UPDATE, DELETE, TRUNCATE` are revoked at provisioning.
4. Async flush: a worker seals completed monthly partitions, writes NDJSON + manifest with `sha256` linkage to object storage with object-lock in compliance mode and a 7-year retention policy. Pointer rows in `audit_archives`.

**Read path.**

- Dashboard audit-log viewer (tenant-scoped via RLS) with filters on actor, tool, time, result, resource.
- Per-tenant export endpoint streaming NDJSON via signed download URL.
- Internal support tooling uses a separate **break-glass** role with its own audit stream.

**Tamper-evidence demo.** A `verify-chain` CLI script ships in the repo; walks a tenant's events, recomputes hashes, checks against archived manifests. Customers can run it themselves.

### Health & status

- `/healthz` — liveness; always 200 if process up.
- `/readyz` — DB, KMS, IdP introspection, OTel collector reachable; 503 with structured reasons otherwise.
- `/status` — per-tenant (auth required): current Openprovider connection status, circuit state, last successful refresh, queue depth, last audit-archive seal time.

### Alerting baseline (SLOs)

- p95 tool latency > 2 s for 5 min → page.
- Openprovider error rate > 5% / 5 min → page.
- `audit.events_lag_seconds` > 600 → page.
- Any `audit.chain.broken` log event → page immediately.
- `secrets.kms_calls` rate-of-change anomaly → notify.
- Token-refresh dead-letter → page.
- Worker queue depth > 1000 for 10 min → page.

### Retention

| Data | Hot | Cold / archive |
|---|---|---|
| Operational logs | 30 days | 1 year |
| Traces | 7 days (sampled) | — |
| Metrics | 13 months | — |
| `audit_events` (Postgres) | 90 days | — |
| Audit archives (object store, locked) | — | **7 years** default (per-tenant configurable up to 10) |

---

## 9. Security & compliance posture

The design is **SOC 2-ready**. Formal certification is out of scope.

### Threat model summary

Primary attacker: a compromised tenant token (OAuth or API key) trying to escalate to another tenant or steal Openprovider credentials. Secondary: a misbehaving / prompt-injected LLM attempting destructive operations or data exfiltration through tool calls. Tertiary: a compromised dependency or operator pivoting from build/CI.

### Secret handling

- Envelope encryption at rest: per-tenant AES-256-GCM data keys, wrapped by a cloud KMS CMK. Ciphertext columns only; no plaintext in DB, logs, traces, or backups.
- DEK rotation quarterly (background re-encryption); CMK rotation annual via KMS automatic rotation.
- Plaintext lifetime: lives in memory only inside `secrets/store` and `openprovider/token-manager`, for the duration of one call.
- Backups inherit storage encryption and are written to a KMS-encrypted bucket. PITR retention 35 days.
- No secrets in source, CI, or environment. CI uses OIDC federation to the cloud; no long-lived credentials.

### Cryptography choices

- TLS 1.2+ everywhere; HSTS on dashboard; internal TLS to DB with pinned CA bundle.
- Hashing: argon2id for API keys (64 MB / 3 iters / per-key salt); sha256 for audit chain + idempotency keys.
- AES-256-GCM via node:crypto / libsodium. Signatures via the IdP. No homegrown crypto.

### Identity, access, authorization

- Tenant authN per §5. RLS on every tenant-scoped table; app role cannot bypass RLS.
- Internal access via SSO-gated bastion; per-engineer ephemeral DB credentials; sessions recorded.
- **Break-glass DB role.** The `app_role` used by the running service has RLS enforced and cannot bypass it. A separate `breakglass_role` is created with `BYPASSRLS` privilege and **no automatic grant** — it requires the bastion's MFA + ticket-binding step to assume. Every `breakglass_role` session opens with a connection-init that inserts a `break_glass_sessions` row (ticket id, operator subject, justification, started_at); a Postgres event trigger forwards every statement executed under that role to a `break_glass_audit` table in a separate schema with its own retention and its own hash chain. The dashboard does **not** use this role; only command-line bastion tooling does.

### Input / output controls

- All MCP inputs validated by zod at the boundary; rejections produce `validation_failed` without an upstream call.
- Path-param substitution uses `encodeURIComponent` over allowlisted placeholders only.
- DB access exclusively parameterized (Drizzle/Kysely or pg with bind params).
- Tool results pass through redaction before returning to the client.
- Pagination defaults capped server-side (e.g., `list_domains` max 500).

### Network & infrastructure

- Egress allowlist: `api.openprovider.eu`, KMS endpoints, IdP, OTel collector. Everything else denied at the VPC level.
- No public DB. All within a private subnet.
- Image hardening: multi-stage build, distroless base, non-root user, read-only root FS.
- Image signing: cosign signatures; deploy verifies before pulling.

### Supply chain

- Lockfile committed; `npm ci` in CI.
- Dependency scanning blocking on high+ severity (Socket or Snyk).
- Dependabot weekly; patch-level automerge only for vetted scopes; `@modelcontextprotocol/*` always manual.
- SBOM (CycloneDX) generated per build, attached to releases.
- SLSA Level 2 provenance attestations via GitHub OIDC.

### Change management

- Trunk-based; protected `main`; code-owner review + green CI required.
- Production deploys are tagged releases; rollback is a one-command redeploy of the prior signed image.
- Migrations follow expand → migrate → contract; reversible.
- Public changelog; security-relevant changes also surfaced in dashboard.

### Vulnerability & incident response

- Quarterly third-party pentest (operator-driven).
- Public security policy + encrypted intake.
- IR runbook: detect → contain → eradicate → recover → post-mortem within 7 days.
- Customer notification SLO 72 h when their data is impacted.
- PagerDuty-style rotation; runbooks linked from every alert.

### Data privacy & residency

- **Default region: EU.**
- Per-tenant export (NDJSON dump, signed URL) — GDPR Art. 20.
- Per-tenant deletion: soft-delete flips `tenants.status='deleted'`; hard-delete after 30-day grace removes ciphertexts; audit archives marked `deleted=true` with payloads redacted but chain preserved for tamper-evidence.
- Sub-processors disclosed: WorkOS, cloud provider (compute / DB / KMS / object store), Openprovider, OTel backend.

### SOC 2 control mapping

| TSC | Control area | Where it lives |
|---|---|---|
| CC6.1 / CC6.6 | Logical access | §5; break-glass role |
| CC6.7 | Transmission encryption | TLS 1.2+, internal TLS to DB |
| CC6.8 | At-rest encryption | KMS envelope; audit object-lock |
| CC7.1 / CC7.2 | Monitoring & anomaly | §8 alerts |
| CC7.3 | Incident response | §9 IR runbook |
| CC7.4 | Recovery | PITR backups, signed image rollback |
| CC8.1 | Change management | Trunk-based + protected `main` + SBOM + signed images |
| CC9.1 | Risk mitigation | Confirmation flow + spend caps + policy engine |
| A1.x | Availability | §8 SLOs, circuit breaker, multi-replica |
| C1.x / P1.x | Confidentiality / privacy | Redaction list, RLS, export/delete, DPA |

---

## 10. Testing strategy

Five layers; each layer answers a distinct question.

### Layer 1 — Unit (Vitest)

Targets pure modules: `policies/engine`, `confirmations` (hash binding), `secrets/store` (round-trip with fake KMS), `auth/identity`, `observability/redact`, error mapping in `openprovider/client`.

- Coverage gates: **90% lines** on `policies/`, `confirmations/`, `secrets/`, `observability/redact`; **80%** elsewhere. Failure breaks CI.
- Snapshot tests for the redaction list against a fixture payload.
- Property tests (fast-check) for `args_hash` order-insensitivity, spend-cap monotonicity, canonical-JSON stability.

### Layer 2 — Integration (Vitest + testcontainers)

- **Postgres + RLS:** every tenant-scoped query must fail cross-tenant. Fixture-driven test: set `app.current_tenant` to tenant A, attempt reads/writes on tenant B's rows — must error. Runs for every repository module.
- **Audit chain:** insert N events, verify chain; tamper one row, confirm the verifier detects it.
- **KMS envelope:** LocalStack / fake KMS validates the full encrypt → wrap → store → load → unwrap → decrypt path.
- **Worker jobs:** pg-boss against a real Postgres; retries, dead-letter, idempotency.
- **Confirmation lifecycle:** propose → expire (clock advanced) → fail to consume; propose → consume → re-consume must fail.

### Layer 3 — Contract tests against Openprovider

- **Recorded contract tests** (Nock / MSW): every Openprovider endpoint has a fixture pair (request, response) checked in. Asserts `openprovider/client` parses real responses correctly. Fixtures regenerated from the Openprovider OpenAPI spec + periodic sandbox runs.
- **Live sandbox suite** (opt-in via env var; runs nightly): exercises the real Openprovider sandbox account end-to-end for read tools and `create_contact`. Doesn't run on PRs. A green nightly is a release gate.

Mocks alone are never the sole test of upstream behavior — mock/prod divergence is exactly how a domain MCP causes incidents.

### Layer 4 — End-to-end MCP

Docker compose: app + Postgres + LocalStack KMS + fake WorkOS. Drive with the official `@modelcontextprotocol/sdk` client. Scenarios that must pass before any release:

1. OAuth happy path: DCR → authorize → `check_domain`.
2. API-key happy path: key issued → `list_domains` via key.
3. Confirmation flow: `register_domain` returns `confirmation_required` → re-call with token executes; stale token → `confirmation_expired`.
4. Policy denial: spend cap below price → `policy_denied`.
5. Cross-tenant isolation: two tenants, parallel sessions; no data leakage.
6. Openprovider 401 recovery: simulate revoked token; expect one transparent refresh + retry.
7. Openprovider 5xx storm: open the circuit, fast-fail, recover.
8. Audit log: expected events emitted; tamper test detects breakage.
9. Idempotency: replay `create_contact` within dedup window returns stored result, no duplicate upstream POST.

### Layer 5 — Security & soak

- **Authz fuzz:** generator over `(role, scope, tool)` triples; assert no combination reaches upstream that wouldn't pass `policies/engine` directly.
- **PII redaction fuzz:** random payloads with planted secrets; redactor must catch every one across logs, traces, audit rows.
- **Load test (k6):** 50 RPS sustained mixed read/write; p95 latency assertion (≤ §7 budget); weekly against staging.
- **Dependency scan:** `npm audit`, Socket on PR; SBOM diff on release.
- **Pentest:** scoped per §9 (operator-driven, annual baseline).

### CI pipeline (PR gates)

```
lint → typecheck → unit (90% gate) → integration → contract (recorded)
                                                              ↓
                                                build + sign image
                                                              ↓
                                                  e2e against image
```

Nightly adds: live-sandbox contract tests, soak load, dep scan, audit-chain verifier across the test corpus.

### Test data

- Canonical "seed tenant" fixture with users in every role, a known policy doc, a stubbed Openprovider binding. Shared across integration and e2e.
- No production data in tests. PII generators (Faker, EU locale) for any large fixture.

### Out of scope

- Openprovider's own behavior (we test our adapter, not their bugs).
- WorkOS internals (we test our adapter, not their OAuth conformance).
- Cloud provider durability of KMS / Postgres / object store.

---

## 11. Migration from current code

This is a rewrite, not a refactor. The current `server.js` / `src/server.ts` becomes the reference for the tool surface only; everything else is new.

- Tool schemas are re-derived from Openprovider's OpenAPI (or hand-rolled zod where the OpenAPI is incomplete). The current JSON schemas are *not* carried over verbatim.
- The current `processContactData` / `processUpdateContactData` mutators are dropped. Phone formatting is the caller's job; we validate, we don't transform.
- The current `login` tool is removed.
- The current `examples/` and `docs/tools.md` files are rewritten against the new tool surface and confirmation flow.
- `package.json` is replaced — new dependencies (zod, pino, pg, drizzle/kysely, @opentelemetry/*, argon2, pg-boss, @workos-inc/node, opossum or equivalent).
- The repository moves from a single file to a layered module structure under `src/`. Module boundaries match §3.

The old code stays on a `legacy/v0.1` branch as a reference; `main` becomes the new design from the first commit.

---

## 12. Open questions / future work (explicitly deferred)

- Multi-region replication (data residency for non-EU enterprise customers).
- SAML / SCIM via WorkOS upgrade tier.
- Metering & invoicing.
- Customer-managed encryption keys (BYOK) — currently we own the CMK.
- Webhook delivery for Openprovider events.
- An MCP "resource" surface for read-heavy data (currently everything is a tool).
- Approver workflow with inline streaming (v1 ships the simpler out-of-band approval).

---

*End of spec.*

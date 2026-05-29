# Changelog

## [0.11.0-api-coverage] — 2026-05-29

### Breaking changes
- **Pricing engine wired to spend-cap.** `renew_domain`, `transfer_domain`, `restore_domain`, `create_ssl_order`, `renew_ssl_order`, `reissue_ssl_order`, `create_plesk_license` now consume from the tenant's `spend_caps.limit_eur` (previously they were priced at 0 and bypassed the cap). Tenants whose cap was set under the prior behavior should raise it before performing these operations or confirmations will be denied with `decision: deny, reason: spend_cap_exceeded`. `trade_domain` remains confirm-without-spend (no public Openprovider price source is available for the trade operation).

### Added — full Openprovider API coverage (97 tools total, +85 since 0.10.0)

**Batch 1 — Domain lifecycle (11 tools):** `suggest_domain`, `get_domain_authcode`, `reset_domain_authcode`, `approve_domain_transfer`, `send_foa1_domain_transfer`, `delete_domain`, `restart_domain_operation`, `renew_domain`, `transfer_domain`, `trade_domain`, `restore_domain`. Migration 0014 seeds the policy modes.

**Batch 2 — DNS (21 tools):** zones (list/get/create/update/delete + list-records), nameservers (list/get/create/update/delete), nameserver groups (list/get/create/update/delete), DNS templates (list/get/create/delete), `create_domain_token`. Migration 0015. `create_dns_zone` uses a flat `records[]` array; `update_dns_zone` uses an `{add[], remove[]}` records object — enforced by schema.

**Batch 3 — Catalog + Tags (6 tools):** `list_tlds`, `get_tld`, `get_domain_price` (Domain Price Service), `list_tags`, `create_tag`, `delete_tag`. Migration 0016. Tag delete is by key+value query params (not path id); tags are key/value pairs (not name/color/description).

**Batch 4 — SSL (15 tools):** `list_ssl_products`, `get_ssl_product`, `list_ssl_orders`, `get_ssl_order`, `get_ssl_approver_emails`, `create_ssl_order`, `renew_ssl_order`, `reissue_ssl_order`, `cancel_ssl_order`, `update_ssl_order`, `update_ssl_approver_email`, `resend_ssl_approver_email`, `create_csr`, `decode_csr`, `create_ssl_otp_token`. Migration 0017.

**Batch 5 — Customers (5 tools):** `list_customers`, `get_customer`, `create_customer`, `update_customer`, `delete_customer`. Migration 0018. Identifier is the customer handle (string), not a numeric ID. `get_deleted_customer` from the spec table was dropped — no distinct OP endpoint exists for it.

**Batch 6 — Email & adjacents (18 tools):** Email templates (list/create/update/delete), email verification (list-domains/start/restart), EasyDmarc (get/list-subscriptions/create/retry/sso-login/delete), Spam Experts (get-domain/generate-login-url/create/update/delete). Migration 0019.

**Batch 7 — License (9 tools):** `list_license_prices`, `list_license_items`, `list_plesk_licenses`, `get_plesk_license`, `get_plesk_key`, `create_plesk_license`, `update_plesk_license`, `reset_plesk_hwid`, `delete_plesk_license`. Migration 0020.

**Policy modes:** reads covered by existing `list_*`/`get_*` wildcards (plus new `check_*`/`suggest_*` wildcards added in Batch 1); low-risk writes are `allow`; deletes and billable confirm-mode writes require owner/admin approval. Catalog count is asserted at **97** in `src/mcp/tool-catalog.test.ts`. Per-batch dispatch + policy integration tests under `tests/integration/mcp/`.

### Added — pricing engine
- `src/policies/pricing/` directory with sub-pricers: `domain-check`, `domain-op`, `ssl-order`, `plesk-license`. `domain-op` uses the Batch-3 `getDomainPrice` endpoint with `operation: renew|transfer|restore`. `ssl-order` uses cached `listSslProducts` + a `getSslOrder` lookup for the renew path. `plesk-license` uses cached `listLicensePrices` + per-SKU sum.
- Env-gated live integration tests against the Openprovider sandbox: `live-domain-price`, `live-ssl-products`, `live-license-prices` (skipped unless `OPENPROVIDER_LIVE=1`).
- Confirm-flow pricing integration test (`tests/integration/policies/pricing-confirm.test.ts`).

### Changed
- `isReadTool` (in `src/policies/engine.ts`) is now **prefix-based**: returns true for any tool name starting with `list_`, `get_`, `check_`, or `suggest_` (plus the explicit `READ_TOOLS` set for outliers like `list_pending_confirmations`). Replaces the hand-maintained set that didn't scale across 97 tools.
- `ruleFor` (in `src/policies/schema.ts`) now does **true longest-prefix wildcard matching** when resolving a tool's policy mode (e.g. `get_secret_*` correctly beats `get_*` for `get_secret_value`). Previously returned the first matching wildcard in `Object.keys` order — harmless at the time, but a latent bug as overlapping wildcards became possible.
- `OpenproviderClient` arg-typed write methods now call `XxxArgs.parse(args)` internally before sending, surfacing schema violations as zod errors instead of remote 4xx. `getDomainPrice` / `deleteTag` use `URLSearchParams` for dot-notation query construction.
- `pricing.price()` is skipped when no Openprovider token is available (the tenant has no creds onboarded). Returns 0 cents → cap-gate skipped. The tenant can't execute a billable in that state anyway (the OP call would fail), so the cap is moot; the confirmation gate still applies.

## [0.10.0-phase6c] — 2026-05-27

### Added
- Local email+password auth: migration 0013 adds `users.password_hash` (nullable), makes `users.oauth_subject` nullable, adds a global active-email unique index, and introduces the `password_resets` table.
- SECURITY DEFINER functions: `signup_tenant` (atomic tenant+owner provisioning), `find_user_by_email`, `consume_password_reset`; `accept_invitation` re-signatured to accept `(token, password_hash)` — invitee sets their password at accept time.
- Dashboard signup and login pages (session via signed `op_dash` cookie, `DASHBOARD_COOKIE_SECRET`).
- Invite-accept-sets-password flow: token possession authorizes acceptance; no separate email-match step.
- Owner/admin token'd reset links (`/dashboard/reset?token=…`, shown once, single-use, 1-hour expiry).
- Logged-in change-password form on the dashboard.
- Invite tokens are single-use and expire after 7 days; all tokens and password hashes use argon2id.

### Changed
- `resolve_or_provision_tenant` (WorkOS-era JIT provisioning) replaced by `signup_tenant` for self-signup and the re-signatured `accept_invitation` for invite acceptance.

### Removed
- WorkOS OAuth: `@workos-inc/node` dependency, the OAuth token verifier (`oauth/workos.ts`), the `tenant-resolver.ts` module, the hosted-login redirect/callback routes, and all `WORKOS_*` configuration (`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_AUTHKIT_DOMAIN`, `WORKOS_JWKS_URI`, `WORKOS_ISSUER`).
- `/mcp` WorkOS JWT path — the endpoint now accepts API keys (`op_live_…`) and the dev bearer token only.

### Tests
- Unit: `password.ts` (argon2id hash/verify + min-12-char policy).
- Integration: `signup_tenant` / `find_user_by_email` / `consume_password_reset` SQL functions; dashboard signup, login, invite-accept-sets-password, reset-link, and change-password routes.
- Local-auth e2e: signup → issue API key → invite teammate → invitee accepts + sets password → login → operator proposes write → owner approves via `confirm_pending`.

### Migration note
Existing WorkOS users have no `password_hash` until an owner issues a reset link. Dev databases are a clean cutover — run `npm run db:migrate` on a fresh schema.

## [0.9.0-phase6b] — 2026-05-27

### Added
- Multi-user invitations: migration 0012 adds the `invitations` table plus `accept_invitation` and `email_has_user` SECURITY DEFINER functions; `resolve_or_provision_tenant` gains a `pending_invite` branch that maps an accepting WorkOS subject into the correct tenant without re-provisioning.
- Token'd email-invite flow: the dashboard generates a single-show accept link (`/dashboard/accept?token=…`); acceptance requires the logged-in WorkOS verified email to match the invitation's email — a leaked token cannot be redeemed by a different identity.
- Full owner / admin / operator / viewer RBAC: the dashboard enforces the matrix via a `requireRole` preHandler on each privileged route (overview, audit, and confirmation-viewing stay open to all roles); the MCP side enforces it via the per-user role on the Principal and the confirmation `required_approver_roles` check (operator may propose a write; only owner/admin may approve).
- Users/Team page (`/dashboard/users`): list members + pending invites, invite by email + role, change role, remove member (also revokes that member's API keys), revoke a pending invite.
- Last-owner guard: demoting or removing the sole remaining owner is rejected at the route layer.

### Tests
- Unit: RBAC helpers, `requireRole` preHandler, legacy-cookie rejection.
- Integration: invitations SQL (`accept_invitation`, `email_has_user`), users-page routes, cross-route RBAC enforcement.
- Two-user e2e: operator proposes a write tool call, owner approves via `confirm_pending`.

### Deferred
- Email delivery (invites are shared as manual links for now).
- WorkOS Organizations / SSO / SCIM (out of scope).

## [0.8.0-phase6] — 2026-05-27

### Added
- API-key authentication: `api_keys` table + `resolve_api_key` SECURITY DEFINER + the `op_live_` path (argon2id), producing a `service` Principal. Keys issued single-show; revoke/expiry enforced.
- Service principals map to an effective policy role (`mcp:write` → `operator`, else `viewer`); they can never approve confirmations.
- Single-owner dashboard (Fastify + eta + htmx, WorkOS hosted login + signed-cookie session + CSRF): overview, Openprovider credential onboarding, policy editor, API-key issue/list/revoke, audit-log viewer + NDJSON export, pending-confirmation approval.
- Shared `onboard-credentials` helper used by both the `tenant:onboard` CLI and the dashboard form.

### Changed
- Upgraded Fastify 4 → 5 (and `@fastify/rate-limit` → 10) — required by the `@fastify/cookie`/`@fastify/view`/`@fastify/static` plugin majors; full suite green on Fastify 5.

### Deferred
- Multi-user invitation + full RBAC (Phase 6b — dashboard is single-owner).
- SSO/SAML/SCIM; dashboard theming; API-key scope narrowing in the UI.

## [0.7.0-phase7] — 2026-05-26

### Added
- Tamper-evident per-tenant audit hash chain: prev_hash/row_hash on audit_events, maintained by an advisory-lock-serialized BEFORE INSERT trigger (genesis-safe).
- `audit:verify` CLI — recomputes the chain (hashing the DB's own ::text rendering to avoid serialization drift) and detects tampering even when the append-only grant is bypassed by an elevated role.
- `audit:seal` CLI — flushes sealed periods to GCS as gzip + sha256 manifest, watermark-idempotent, writes audit_archives pointers.
- GCS object store (`@google-cloud/storage`); seal targets a bucket with a locked retention policy.

### Changed
- **Migrated KMS from AWS to GCP** (single-cloud GCP). New `gcp-kms.ts` (client-side DEK + KMS wrap via the existing Kms interface). AWS removed entirely: deleted aws-kms.ts + LocalStack helper, dropped @aws-sdk/client-kms.
- Integration KMS now uses the in-process fake adapter; real GCP KMS fidelity is in an opt-in GCP_LIVE suite. LocalStack replaced by fake-gcs-server.
- Config: GCP_PROJECT_ID / GCP_KMS_KEY_NAME / GCS_BUCKET replace the AWS_* vars.

### Deferred
- Monthly partitioning of audit_events (Phase 8 if volume warrants).
- pg-boss always-on workers / scheduled sealing (Phase 8) — audit:seal is cron-triggerable.
- Dashboard (Phase 6).

## [0.6.0-phase5] — 2026-05-26

### Added
- Write tools: `register_domain`, `update_domain` (confirm-mode, billable), `create_contact` (allow-mode), `update_contact` + `delete_contact` (confirm-mode).
- Strict zod arg schemas for writes; the legacy silent mutation (India phone area-code splitting, role/is_active defaulting, auto-username) is gone — malformed input is rejected.
- `idempotency_records` table (migration 0009) + `withIdempotency` replay for allow-mode `create_contact` (10-min window, auto-hash key).
- Claim-before-execute for confirm-mode writes: atomic `UPDATE confirmations SET consumed_at WHERE consumed_at IS NULL RETURNING` gates execution, preventing concurrent double-execution of billable/destructive ops; failure un-claims for re-approval.
- Optional `X-Idempotency-Key` header sent upstream best-effort.
- Opt-in live-sandbox contact round-trip test (non-billable; env-gated). `register_domain` is never executed against the live sandbox.

### Changed
- Write tools ride Phase 4's data-driven policy modes — no new dispatcher branch.

### Deferred
- Dashboard + API keys (Phase 6); pg-boss workers (Phase 7); domain transfer/trade/renew/restore/authcode, SSL/DNS/etc. (future).

## [0.5.0-phase4] — 2026-05-26

### Added
- Policy engine (`policies/engine`): per-tenant allow/deny/confirm with TLD allow+deny, role gate, and spend-cap evaluation.
- Content-bound confirmation flow: propose mints a confirmation + pending spend reservation; consume verifies hash/expiry/approver-role, re-prices with a 5% drift guard, then executes.
- Spend reservations with a lazy, worker-free accounting model: live spend computed from reservations (expired pending holds drop out via expires_at); SELECT … FOR UPDATE on the policy row serializes concurrent proposals (no overshoot — proven by a concurrency test).
- `list_pending_confirmations` + `confirm_pending` meta-tools (approver handoff).
- Default-on-provision policy (spend cap €0 = billable writes blocked until raised) seeded in resolve_or_provision_tenant; `policy:show` / `policy:set` CLI.
- Pricing module: cents-based, 24h TLD cache, premium-domain bypass, EUR-only.
- Migration 0008: policies, confirmations, spend_reservations (all RLS-scoped).

### Changed
- Dispatcher gained a confirm-mode branch (propose returns a confirmation token; consume executes the handler and settles the reservation).
- All money math is integer cents internally.

### Deferred
- Real write tools (register_domain etc.) + idempotency records — Phase 5.
- pg-boss workers (sweep / window rollup) — Phase 7/8.
- day/week spend windows; dashboard policy editor — Phase 6.

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

## [0.2.0-phase2] — 2026-05-22

### Added
- WorkOS OAuth bearer-token verification (`@workos-inc/node` + `jose` JWKS cache, RS256 only).
- `/.well-known/oauth-protected-resource` discovery endpoint (RFC 9728).
- `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` replaces the Phase 1 JSON-RPC shim; sessions tracked via `Mcp-Session-Id`. SSE supported on GET `/mcp`.
- Openprovider HTTP client with retry, abort timeout, opossum circuit breaker, and structured error mapping (`OpenproviderAuthError`, `OpenproviderRateLimitError`, `OpenproviderUnavailableError`, `OpenproviderClientError`).
- Per-tenant Openprovider token manager with singleflight refresh, in-memory cache, and Postgres-backed cross-replica cache (envelope-encrypted via per-tenant DEK).
- `openprovider_accounts` table with RLS and envelope-encrypted cached_token columns (migration 0006).
- Tool dispatch pipeline with `audit_events` writes on every call/result/error, redaction-applied request_args + result payloads.
- Postgres audit sink bound to the per-request `pg.PoolClient` (RLS-scoped writes).
- First real tool: `check_domain` (read-only, scope-checked only — policy gate lands in Phase 4).
- Per-bearer rate limit on `/mcp` (60 req/min default) via `@fastify/rate-limit` (downgraded to v9 to match Fastify 4).
- End-to-end test exercising OAuth happy path, cross-tenant isolation, and 401 paths against real Postgres, real LocalStack KMS, Nock-mocked Openprovider and JWKS.

### Changed
- Identity resolver consumes a `verifier` adapter; the dev token remains as a developer escape hatch.
- Role is provisionally derived from OAuth scopes (`mcp:write` → operator, else viewer) until Phase 6 introduces RBAC stored in the `users` table.
- Per-request dispatch is acquired via `dispatchFactory(principal)`; the factory binds a transaction-scoped pg client, sets `app_role` + `app.current_tenant` GUC, constructs all per-tenant deps, and commits/releases in cleanup. `tools/call` is intercepted at the Fastify layer; `initialize`, `tools/list`, and SSE continue through the SDK transport.

### Deferred to later phases
- List / get / update domain + contact tools (Phase 3).
- Policy engine + confirmations + spend reservations (Phase 4).
- Write tools + approver workflow (Phase 5).
- Dashboard + API keys (Phase 6).
- Audit hash chain + object-store flush (Phase 7).

### Known gaps in this phase
- Rate limit is keyed on the Authorization header prefix (limiter runs before auth); Phase 3 introduces a per-principal limiter once auth is a preHandler.
- `getDek` is duplicated between `secrets/store` and `dispatchFactory`; a `secrets/dek.ts` consolidation is queued for Phase 3 cleanup.
- Husky v9 pre-commit hook emits a deprecation notice (cosmetic); fix when bumping to v10.

## [0.2.0-phase1] — 2026-05-21

### Added
- Multi-tenant Postgres schema with row-level security on `tenants`, `users`, `tenant_keys`, `tenant_secrets`, `audit_events`.
- Append-only `audit_events` (UPDATE/DELETE/TRUNCATE revoked for `app_role`).
- Envelope-encrypted secrets store with per-tenant AES-256-GCM DEKs wrapped by AWS KMS (LocalStack in tests).
- Streamable HTTP MCP transport scaffold with placeholder `phase1.echo` tool.
- Dev-token identity resolver (OAuth + API keys deferred to Phase 2/6).
- pino structured logger with single-source redaction list per spec §8.
- OpenTelemetry Node SDK bootstrap.
- `/healthz` and `/readyz` with structured per-check results.
- Multi-stage distroless non-root Dockerfile.
- GitHub Actions CI with lint, typecheck, unit + integration tests via testcontainers, and CycloneDX SBOM artifact.
- Pre-commit hooks (prettier + eslint + typecheck) via husky + lint-staged.

### Changed
- Replaced the single-file stdio MCP server with a layered TypeScript codebase under `src/`.
- Bumped Node baseline to 20.11.
- DB tenant context is set via `set_config('app.current_tenant', $1, true)` (parameter-safe), not `SET LOCAL ... = $1` (which Postgres rejects parameterized).

### Removed
- Legacy `server.js` / `src/server.ts` / `test-*.js` scripts (preserved on `legacy/v0.1` branch).

### Deferred to later phases
- Real WorkOS OAuth (Phase 2).
- Openprovider client + token manager (Phase 3).
- Policy engine + confirmations (Phase 4).
- Write tools + approver flow (Phase 5).
- Dashboard (Phase 6).
- Audit hash chain + object-store flush (Phase 7).
- Hardening (Phase 8).
- Release engineering: cosign signing against a registry, SLSA L2 provenance (Phase 9).

### Known gaps in this phase
- MCP transport uses direct JSON-RPC routing for `tools/list` and `tools/call`; replaced with `StreamableHTTPServerTransport` in Phase 2.
- cosign image signing in CI assumes a registry; signing step is intentionally absent until Phase 9 wires the registry.
- AWS SDK emits a `NodeVersionSupportWarning` on Node 20.11 (future SDKs require ≥22). Base image upgrade tracked for Phase 9.

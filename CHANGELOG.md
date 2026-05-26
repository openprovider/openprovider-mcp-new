# Changelog

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

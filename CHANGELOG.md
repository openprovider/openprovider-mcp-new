# Changelog

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

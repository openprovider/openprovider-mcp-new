# Changelog

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

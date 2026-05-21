# Openprovider MCP — Enterprise (v0.2 Phase 1: Foundation)

A multi-tenant SaaS MCP server for Openprovider. **Phase 1 is the foundation only** — Streamable HTTP scaffold, Postgres + RLS, KMS envelope-encrypted secrets, OpenTelemetry, health endpoints, signed-image CI. No tenant onboarding, no real Openprovider integration, no policies. See the spec and roadmap below for the full picture.

## Status

- Foundation phase complete: see `CHANGELOG.md` for the `0.2.0-phase1` tag.
- Next: Phase 2 ships the first end-to-end vertical slice (WorkOS OAuth + `check_domain` over Streamable HTTP).

## Documents

- **Spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md`
- **Phase roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md`
- **Phase 1 plan (this phase):** `docs/superpowers/plans/2026-05-21-enterprise-mcp-phase-1-foundation.md`
- **Legacy v0.1 server:** archived on the `legacy/v0.1` branch.

## Local development

Requires Node 20.11+, Docker.

```bash
nvm use
npm install
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
npm run db:migrate
npm run dev
curl -H 'authorization: Bearer dev-bearer-only-for-phase1' \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:3000/mcp
```

## Tests

```bash
npm test                  # unit, coverage gates
npm run test:integration  # Postgres + LocalStack KMS via testcontainers
npm run lint
npm run typecheck
```

## License

MIT — see `LICENSE`.

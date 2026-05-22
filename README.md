# Openprovider MCP — Enterprise (v0.2 Phase 2: First vertical slice)

A multi-tenant SaaS MCP server for Openprovider. **Phase 2 ships the first end-to-end vertical slice:** WorkOS OAuth authentication, `/.well-known/oauth-protected-resource` discovery, the official MCP SDK Streamable HTTP transport, an Openprovider HTTP client with retry / timeout / circuit breaker, a per-tenant Openprovider token manager with envelope-encrypted Postgres cache, a tool dispatch pipeline with audit-on-every-call, and the first real tool — `check_domain` — wired end-to-end with cross-tenant RLS isolation.

## Status

- Phase 2 complete: `v0.2.0-phase2` tag.
- Phase 1 (foundation) is preserved on the `v0.2.0-phase1` tag and the same `feat/enterprise-phase-1` branch.

## Documents

- **Spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md`
- **Phase roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md`
- **Phase 1 plan:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-phase-1-foundation.md`
- **Phase 2 plan (this phase):** `docs/superpowers/plans/2026-05-22-enterprise-mcp-phase-2-vertical-slice.md`
- **WorkOS dev project decision:** `docs/superpowers/decisions/2026-05-22-workos-dev-project.md` (created during Phase 2 Task 1)
- **Legacy v0.1 server:** archived on the `legacy/v0.1` branch.

## Tools exposed

| Tool | Status | Notes |
|---|---|---|
| `phase1.echo` | placeholder | proves transport + auth wiring |
| `check_domain` | **live** | calls Openprovider `/v1beta/domains/check` per tenant |

## Local development

Requires Node 20.11+, Docker, a WorkOS sandbox project (free tier).

```bash
nvm use
npm install
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
# Edit .env and paste your real WORKOS_* values from your WorkOS dashboard.
npm run db:migrate
npm run dev
```

### Hitting the MCP endpoint

`/mcp` requires either a dev bearer (`DEV_BEARER_TOKEN`) or a WorkOS access token carrying `act.tnt = <tenantId>`.

```bash
curl -H "authorization: Bearer $DEV_BEARER_TOKEN" \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
     http://localhost:3000/mcp
# Note the Mcp-Session-Id response header; use it for subsequent requests.
```

### Discovery

```bash
curl http://localhost:3000/.well-known/oauth-protected-resource
```

## Tests

```bash
npm test                  # unit, coverage gates
npm run test:integration  # Postgres + LocalStack KMS via testcontainers + e2e
npm run lint
npm run typecheck
```

## License

MIT — see `LICENSE`.

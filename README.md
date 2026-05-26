# Openprovider MCP — Enterprise (v0.4 Phase 3: Real AuthKit auth + read tools)

A multi-tenant SaaS MCP server for Openprovider. **Phase 3 completes real WorkOS AuthKit authentication** (tenant auto-provisioned on first login; each WorkOS user maps 1:1 to a tenant) **and ships the four read tools** (`list_domains`, `get_domain`, `list_contacts`, `get_contact`) end-to-end. Phase 2 shipped the first vertical slice: OAuth, discovery, MCP SDK transport, Openprovider HTTP client, per-tenant token manager, audit pipeline, and `check_domain`.

## Status

- Phase 3 complete: `v0.4.0-phase3` tag.
- Phase 2 complete: `v0.2.0-phase2` tag.
- Phase 1 (foundation) is preserved on the `v0.2.0-phase1` tag and the same `feat/enterprise-phase-1` branch.

## Documents

- **Spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md`
- **Phase 3 auth spec:** `docs/superpowers/specs/2026-05-26-phase3-auth-tenant-mapping-design.md`
- **Phase roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md`
- **Phase 1 plan:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-phase-1-foundation.md`
- **Phase 2 plan:** `docs/superpowers/plans/2026-05-22-enterprise-mcp-phase-2-vertical-slice.md`
- **Phase 3 plan:** `docs/superpowers/plans/2026-05-26-enterprise-mcp-phase-3.md`
- **WorkOS dev project decision:** `docs/superpowers/decisions/2026-05-22-workos-dev-project.md` (created during Phase 2 Task 1)
- **Legacy v0.1 server:** archived on the `legacy/v0.1` branch.

## Tools exposed

| Tool | Status | Notes |
|---|---|---|
| `phase1.echo` | placeholder | proves transport + auth wiring |
| `check_domain` | **live** | calls Openprovider `/v1beta/domains/check` per tenant |
| `list_domains` | **live** | lists domains in the tenant's Openprovider account |
| `get_domain` | **live** | fetches one domain by Openprovider domain id |
| `list_contacts` | **live** | lists contacts in the tenant's Openprovider account |
| `get_contact` | **live** | fetches one contact by Openprovider contact id |

## Authentication

Real WorkOS AuthKit tokens are now accepted. On first login the server atomically provisions a tenant and owner user — no pre-seeding required. Each WorkOS user maps 1:1 to a tenant via `users.oauth_subject`.

Before a tenant can call Openprovider tools, their Openprovider credentials must be onboarded:

```bash
npm run tenant:onboard -- --tenant <uuid> --username <op-user> --password <pass>
```

`<uuid>` is the `tenant_id` returned by `resolve_or_provision_tenant` (visible in the DB after the user's first login).

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

`/mcp` requires either a dev bearer (`DEV_BEARER_TOKEN`) or a real WorkOS AuthKit access token. The token is verified, and the user's tenant is resolved (or provisioned) automatically.

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

# Openprovider MCP — Enterprise (v0.5 Phase 4: Policy engine + confirmations + spend reservations)

A multi-tenant SaaS MCP server for Openprovider. **Phase 4 ships the policy engine, content-bound confirmation flow, and atomic spend-reservation accounting** — plus `list_pending_confirmations` / `confirm_pending` meta-tools and a default-on-provision policy (spend cap €0). Phase 3 completed real WorkOS AuthKit authentication and the four read tools. Phase 2 shipped the first vertical slice: OAuth, discovery, MCP SDK transport, Openprovider HTTP client, per-tenant token manager, audit pipeline, and `check_domain`.

## Status

- Phase 4 complete: `v0.5.0-phase4` tag.
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
- **Phase 4 plan:** `docs/superpowers/plans/2026-05-26-enterprise-mcp-phase-4.md`
- **Phase 4 spec:** `docs/superpowers/specs/2026-05-26-phase4-policy-confirmations-design.md`
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
| `list_pending_confirmations` | **live** (meta) | lists confirmations the caller's role may approve |
| `confirm_pending` | **live** (meta) | approves and executes a pending confirmation by id |

## Spend controls & confirmations

The default policy provisioned for every new tenant has a **spend cap of €0**, which means all billable write tools (e.g. `register_domain`, `update_domain`) are blocked until the cap is raised. Read tools and `check_domain` are always allowed.

Billable tools that are configured as `confirm`-mode follow a two-step propose → confirm flow:

1. Call the tool without a confirmation token → the server returns `confirmation_required` with a `confirmation_id` and a cost estimate.
2. An approver (owner or admin role) calls `confirm_pending` with that `confirmation_id` to execute the operation.

Pending confirmations expire after 5 minutes. The server re-prices at confirm time and rejects the request if the price has drifted more than 5%.

### Managing policies

Inspect the current policy for a tenant:

```bash
npm run policy:show -- --tenant <uuid>
```

Apply a new policy from a JSON file:

```bash
npm run policy:set -- --tenant <uuid> --file policy.json
```

A minimal policy that allows billable writes up to €100/month:

```json
{
  "version": 1,
  "spend_caps": { "window": "month", "limit_eur": 100 },
  "tld_allowlist": [],
  "tld_denylist": [],
  "tools": {
    "list_*": "allow",
    "get_*": "allow",
    "check_domain": "allow",
    "register_domain": "confirm",
    "update_domain": "confirm",
    "delete_contact": "confirm",
    "update_contact": "confirm",
    "create_contact": "allow"
  },
  "ip_allowlist": []
}
```

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

# Openprovider MCP — Enterprise (v0.8.0 Phase 6: API-key auth + single-owner dashboard)

A multi-tenant SaaS MCP server for Openprovider. **Phase 6 ships `op_live_` API-key authentication (argon2id, `api_keys` table, `resolve_api_key` SECURITY DEFINER) and a single-owner server-rendered dashboard** (Fastify + eta + htmx, WorkOS hosted login) for credential onboarding, policy editing, API-key management, audit viewing, and confirmation approval. Phase 7 migrated secrets/KMS from AWS KMS to GCP KMS (single-cloud) and added a tamper-evident per-tenant audit hash chain. Phase 5 shipped the five write tools (`register_domain`, `update_domain`, `create_contact`, `update_contact`, `delete_contact`) on Phase 4's confirmation machinery. Phase 4 shipped the policy engine, content-bound confirmation flow, and atomic spend-reservation accounting. Phase 3 completed real WorkOS AuthKit authentication and the four read tools. Phase 2 shipped the first vertical slice: OAuth, discovery, MCP SDK transport, Openprovider HTTP client, per-tenant token manager, audit pipeline, and `check_domain`.

## Status

- Phase 6 complete: `v0.8.0-phase6` tag.
- Phase 7 complete: `v0.7.0-phase7` tag.
- Phase 5 complete: `v0.6.0-phase5` tag.
- Phase 4 complete: `v0.5.0-phase4` tag.
- Phase 3 complete: `v0.4.0-phase3` tag.
- Phase 2 complete: `v0.2.0-phase2` tag.
- Phase 1 (foundation) is preserved on the `v0.2.0-phase1` tag and the same `feat/enterprise-phase-1` branch.

## Documents

- **Spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md`
- **Phase 3 auth spec:** `docs/superpowers/specs/2026-05-26-phase3-auth-tenant-mapping-design.md`
- **Phase 4 spec:** `docs/superpowers/specs/2026-05-26-phase4-policy-confirmations-design.md`
- **Phase 5 spec:** `docs/superpowers/specs/2026-05-26-phase5-write-tools-design.md`
- **Phase 6 spec:** `docs/superpowers/specs/2026-05-26-phase6-dashboard-design.md`
- **Phase 7 spec:** `docs/superpowers/specs/2026-05-26-phase7-gcp-and-audit-chain-design.md`
- **Phase roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md`
- **Phase 1 plan:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-phase-1-foundation.md`
- **Phase 2 plan:** `docs/superpowers/plans/2026-05-22-enterprise-mcp-phase-2-vertical-slice.md`
- **Phase 3 plan:** `docs/superpowers/plans/2026-05-26-enterprise-mcp-phase-3.md`
- **Phase 4 plan:** `docs/superpowers/plans/2026-05-26-enterprise-mcp-phase-4.md`
- **Phase 5 plan:** `docs/superpowers/plans/2026-05-26-enterprise-mcp-phase-5.md`
- **Phase 6 plan:** `docs/superpowers/plans/2026-05-27-enterprise-mcp-phase-6.md`
- **Phase 7 plan:** `docs/superpowers/plans/2026-05-26-enterprise-mcp-phase-7.md`
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
| `register_domain` | **live** (confirm-mode) | registers a new domain (billable); requires an existing owner contact handle |
| `update_domain` | **live** (confirm-mode) | updates nameservers, autorenew, DNSSEC, WHOIS privacy |
| `create_contact` | **live** (allow-mode) | creates a new contact handle; idempotent on identical args (10-min window) |
| `update_contact` | **live** (confirm-mode) | updates an existing contact by id |
| `delete_contact` | **live** (confirm-mode) | deletes a contact by id (destructive) |

### Write operations

Confirm-mode tools (`register_domain`, `update_domain`, `update_contact`, `delete_contact`) follow a two-step flow:

1. Call the tool without a confirmation token → the server returns `confirmation_required` with a `confirmation_id`.
2. An approver (owner or admin role) calls `confirm_pending` with that `confirmation_id` to execute the operation.

Writes are deduplicated: confirm-mode tools atomically claim the confirmation before executing (a concurrent second `confirm_pending` for the same id is rejected); `create_contact` (allow-mode) deduplicates by args hash with a 10-minute replay window.

`register_domain` does **not** auto-create contacts — create the owner contact handle first with `create_contact`, then pass the returned handle as `owner_handle` to `register_domain`.

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

Before a tenant can call Openprovider tools, their Openprovider credentials must be onboarded via the dashboard (see below) or the CLI:

```bash
npm run tenant:onboard -- --tenant <uuid> --username <op-user> --password <pass>
```

`<uuid>` is the `tenant_id` returned by `resolve_or_provision_tenant` (visible in the DB after the user's first login).

## Dashboard

Phase 6 ships a single-owner server-rendered dashboard mounted at `/dashboard` on the same Fastify server. Authentication uses WorkOS hosted login (redirect to WorkOS → callback sets a signed cookie session).

### Pages

| Path | Description |
|---|---|
| `/dashboard` | Overview — Openprovider connection status, active policy spend cap, live spend |
| `/dashboard/openprovider` | Openprovider credential onboarding — username + password form (encrypts via GCP KMS, same path as the CLI) |
| `/dashboard/policy` | Policy editor — JSON textarea with Zod validation; inline errors on bad input |
| `/dashboard/keys` | API-key management — issue keys (plaintext shown once), list with prefix/name/last-used/status, revoke |
| `/dashboard/audit` | Audit log viewer — paginated table with event-type + tool filters; NDJSON export |
| `/dashboard/confirmations` | Pending confirmation approval — lists unexpired confirmations, approve drives the same consume path as `confirm_pending` |

All state-changing POSTs are CSRF-protected (signed-cookie token round-trip).

> **Single-owner:** The dashboard is provisioned for a single owner per tenant. Multi-user invitation and full RBAC are deferred to Phase 6b.

## API Keys

Phase 6 introduces `op_live_` API keys as an alternative to WorkOS AuthKit tokens for `/mcp` access.

- Keys are issued via the **dashboard keys page** (`/dashboard/keys`). The plaintext is shown exactly once at issuance and is never stored — only an argon2id hash is persisted.
- Key format: `op_live_<base64url-random>` (first 12 characters form the lookup prefix).
- Use as a bearer token: `Authorization: Bearer op_live_<key>`.
- Keys produce a `service` Principal. Effective policy role: `mcp:write` scope → `operator`; otherwise `viewer`. Service principals cannot approve confirmations.
- Keys can be revoked or given an expiry; revoked/expired keys are rejected at resolve time.

```bash
curl -H "Authorization: Bearer op_live_<your-key>" \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
     http://localhost:3000/mcp
```

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

### GCP environment variables

Phase 7 uses GCP as the sole cloud provider (AWS has been removed). Set these in `.env`:

| Variable | Description |
|---|---|
| `GCP_PROJECT_ID` | GCP project that owns the KMS key ring and GCS bucket |
| `GCP_KMS_KEY_NAME` | Full resource name: `projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>` |
| `GCS_BUCKET` | GCS bucket for sealed audit archives (must have a **locked retention policy**) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account JSON key (omit when using Workload Identity / ADC) |

For local development, `fake-gcs-server` replaces LocalStack. The `docker-compose.dev.yml` starts it on port `4443`. Set `STORAGE_EMULATOR_HOST=http://localhost:4443` to point the GCS client at the local emulator.

### Dashboard environment variables

| Variable | Description |
|---|---|
| `DASHBOARD_COOKIE_SECRET` | Secret used to sign the `op_dash` session cookie (min 32 chars; generate with `openssl rand -hex 32`) |

The dashboard uses WorkOS hosted login — the existing `WORKOS_CLIENT_ID` and `WORKOS_CLIENT_SECRET` vars apply. Set `WORKOS_REDIRECT_URI` to `http://localhost:3000/dashboard/login/callback` in your WorkOS sandbox project.

### Fastify version

Phase 6 upgraded **Fastify 4 → 5** (and `@fastify/rate-limit` → 10) — required by the `@fastify/cookie`, `@fastify/view`, and `@fastify/static` plugin majors used by the dashboard. The full test suite is green on Fastify 5.

### Audit commands

```bash
# Verify the per-tenant audit hash chain (detects tampering even by elevated DB roles)
npm run audit:verify -- --tenant <uuid>

# Seal a period's audit events to GCS as a gzip + sha256 manifest archive
npm run audit:seal -- --before <YYYY-MM-DD> --tenant <uuid>
```

### Audit integrity

Every row inserted into `audit_events` is chained by a `BEFORE INSERT` trigger:

- `prev_hash` — the `row_hash` of the previous row for this tenant (32 zero bytes for the genesis row).
- `row_hash` — `SHA-256(prev_hash || UTF8(canonical_fields))`, where the canonical string joins 15 fields with `|` using the DB's own `::text` rendering (no JS reformatting — zero serialization drift).
- The trigger acquires a per-tenant advisory lock so concurrent inserts produce a linear chain.

`audit:verify` re-reads every row (fetching all hashed fields as `::text`) and recomputes the chain in TypeScript. A mismatch — even one caused by an elevated role that bypasses the append-only `app_role` grant — is reported as `audit.chain.broken`.

`audit:seal` flushes rows for a tenant/period to GCS as a `.ndjson.gz` file and records the archive pointer (including `last_row_hash`) in `audit_archives`. Re-sealing the same period is a no-op (watermark-idempotent). The GCS bucket's locked retention policy prevents premature deletion of sealed archives.

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
npm run test:integration  # Postgres + fake-gcs-server via testcontainers + e2e
npm run lint
npm run typecheck
```

## License

MIT — see `LICENSE`.

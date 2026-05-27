# Openprovider MCP — Enterprise (v0.10.0 Phase 6c: local email+password auth)

A multi-tenant SaaS MCP server for Openprovider. **Phase 6c replaces WorkOS OAuth with self-hosted email+password authentication** (argon2id, migration 0013, signup/login/invite/reset dashboard flows). Phase 6b added multi-user invitations and full RBAC. Phase 6 shipped `op_live_` API-key authentication and a server-rendered dashboard. Phase 7 migrated secrets/KMS from AWS KMS to GCP KMS (single-cloud) and added a tamper-evident per-tenant audit hash chain. Phase 5 shipped the five write tools (`register_domain`, `update_domain`, `create_contact`, `update_contact`, `delete_contact`) on Phase 4's confirmation machinery. Phase 4 shipped the policy engine, content-bound confirmation flow, and atomic spend-reservation accounting. Phase 3 completed authentication and the four read tools. Phase 2 shipped the first vertical slice: OAuth, discovery, MCP SDK transport, Openprovider HTTP client, per-tenant token manager, audit pipeline, and `check_domain`.

## Status

- Phase 6c complete: `v0.10.0-phase6c` tag.
- Phase 6b complete: `v0.9.0-phase6b` tag.
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

Authentication is **local email+password** — there is no external IdP. The dashboard provides signup and login pages; sessions are signed cookies (`op_dash`, keyed by `DASHBOARD_COOKIE_SECRET`).

**Self-signup.** `POST /dashboard/signup` with an email and a password (minimum 12 characters) atomically provisions a new tenant and owner user.

**Invitations.** An owner or admin invites a teammate by email and role. The dashboard generates a token'd accept link (`/dashboard/accept?token=…`) shown once in the UI. The invitee opens the link and **sets their own password** — token possession is sufficient to authorize acceptance; no separate email-match step is required. Email delivery is deferred (the inviting user shares the link manually). Invite tokens expire after 7 days and are single-use.

**Password reset.** An owner or admin can issue a single-use reset link (`/dashboard/reset?token=…`) shown once in the UI. Reset tokens expire after 1 hour. Logged-in users can also change their password directly. There is no self-service "forgot password" flow yet (an email channel is required).

**Passwords** are hashed with argon2id. Reset and invite tokens are single-use and expiring.

**`/mcp` authenticates by API key (`op_live_…`) or the dev bearer token** (`DEV_BEARER_TOKEN`). The WorkOS OAuth/JWT path has been removed.

**RBAC** is unchanged from Phase 6b — owner/admin/operator/viewer roles are enforced on the dashboard (`requireRole` preHandler) and on the MCP approver-role check. See the RBAC matrix in the Dashboard section.

Before a tenant can call Openprovider tools, their Openprovider credentials must be onboarded via the dashboard (see below) or the CLI:

```bash
npm run tenant:onboard -- --tenant <uuid> --username <op-user> --password <pass>
```

`<uuid>` is the `tenant_id` provisioned at signup (visible in the DB after `POST /dashboard/signup` or as the owner's `tenant_id`).

## Dashboard

The dashboard is mounted at `/dashboard` on the same Fastify server. Authentication uses local email+password (signup/login forms → signed cookie session). No external IdP is required.

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

### Phase 6b / 6c — Team & RBAC

Phase 6b added multi-user invitations and a full owner/admin/operator/viewer RBAC model. Phase 6c replaced WorkOS with local auth while preserving the same RBAC structure.

**Invitations.** An owner or admin invites a teammate by email and role (admin, operator, or viewer — the owner role is never assignable via invitation). The dashboard generates a token'd accept link (`/dashboard/accept?token=…`) shown once in the UI. The invitee opens the link and sets their password — token possession authorizes acceptance. Email delivery is not yet automated — the inviting user shares the link manually. Invite tokens are single-use and expire after 7 days.

**One user = one tenant.** An email that already belongs to any existing user cannot be invited again. A global active-email unique index enforces this at the DB layer.

**RBAC matrix.**

| Surface | owner | admin | operator | viewer |
|---|---|---|---|---|
| Overview / audit (view) | ✓ | ✓ | ✓ | ✓ |
| Openprovider creds (rotate) | ✓ | — | — | — |
| Policy edit | ✓ | ✓ | — | — |
| API keys issue/revoke | ✓ | ✓ | — | — |
| Users/Team (invite/role/remove) | ✓ | ✓¹ | — | — |
| Confirmations: view | ✓ | ✓ | ✓ | ✓ |
| Confirmations: approve | ✓ | ✓ | — | — |
| MCP read tools | ✓ | ✓ | ✓ | ✓ |
| MCP write tools (propose) | ✓ | ✓ | ✓ | — |

¹ An admin may manage operator/viewer/admin roles but cannot modify or remove an owner, nor grant the owner role.

**Guards.** The dashboard enforces the matrix via a `requireRole` preHandler on every route. On the MCP/tool side, the per-user role is carried on the Principal; the confirmation `required_approver_roles` check means an operator can propose a write but only an owner or admin can approve it. A **last-owner guard** prevents demoting or removing the sole remaining owner. Removing a user also revokes all of their API keys.

**Users/Team page.** `/dashboard/users` (owner + admin only) — lists current members with their roles, lists pending invitations, and provides controls to invite, change role, remove a member, or revoke a pending invite.

## API Keys

`op_live_` API keys are the primary programmatic authentication method for `/mcp` access (alongside the dev bearer token).

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

Requires Node 20.11+, Docker.

```bash
nvm use
npm install
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
# Edit .env — set DASHBOARD_COOKIE_SECRET and DEV_BEARER_TOKEN at minimum.
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
| `DEV_BEARER_TOKEN` | Dev escape-hatch bearer token for `/mcp` (omit in production) |

No `WORKOS_*` variables are required. The dashboard uses local email+password auth only.

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

`/mcp` accepts either a dev bearer (`DEV_BEARER_TOKEN`) or an `op_live_` API key. WorkOS AuthKit tokens are no longer accepted.

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

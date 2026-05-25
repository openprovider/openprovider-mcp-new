# Enterprise Openprovider MCP — Phase Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: this is a *phase roadmap*, not a TDD task plan. Each phase below is a milestone that, when scheduled for execution, must be expanded into its own task-level plan via `superpowers:writing-plans` and then driven through `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Do **not** start coding from this document directly — pick a phase, write its detailed plan, then execute.

**Source spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md`

**Goal:** Sequence the rewrite of the Openprovider MCP from a single-file hobby-grade stdio server into a multi-tenant, SOC 2-ready SaaS, decomposed into phases that each produce shippable, testable software on their own.

**Architecture:** Approach A from the spec — single Node.js/TypeScript service exposing `/mcp` (Streamable HTTP), `/dashboard`, and `/oauth/*` against managed Postgres + cloud KMS + an OTel collector, with workers in the same image. WorkOS as the IdP. EU default region.

**Tech Stack:** Node.js 20+ / TypeScript / Fastify (or Hono) / `@modelcontextprotocol/sdk` / Drizzle (or Kysely) / pg / pg-boss / zod / pino / `@opentelemetry/*` / argon2 / `@workos-inc/node` / opossum / Vitest / testcontainers / Docker / cosign / GitHub Actions.

---

## Phase ordering rules

1. **Each phase ships independently.** End of every phase produces a release tag, a green CI run, and a deployable image. No phase leaves the trunk red.
2. **Vertical slices over horizontal layers.** Phase 2 is the first end-to-end vertical: one MCP read tool over Streamable HTTP, with real OAuth, real Postgres, real audit. We do *not* build all of one layer before any of the next.
3. **Money- and PII-touching features come after their controls.** Phase 5 (write tools) cannot start before Phase 4 (policy engine + confirmations + spend reservations) lands.
4. **Hardening is its own phase, not sprinkled.** Phase 8 collects security + performance + resilience polish so it doesn't get sacrificed to feature pressure.
5. **Each phase has an explicit exit checklist.** Crossing into the next phase requires all checklist items green; no partial promotion.

---

## Phase summary

| # | Phase | Spec sections | Est. effort* | Depends on |
|---|---|---|---|---|
| 1 | Foundation: repo skeleton, CI, Postgres+RLS, KMS secrets, observability, health endpoints | §3, §4 (schema bones), §8, §9 (supply chain) | 2–3 wks | — |
| 2 | First end-to-end slice: Streamable HTTP transport + WorkOS OAuth + `check_domain` read tool | §2, §3, §5 (Layer 1), §6 (read tools), §7 (errors) | 3–4 wks | 1 |
| 3 | Openprovider token manager + secrets onboarding + remaining read tools | §4 (`openprovider_accounts`), §5 (Layer 2), §6 (read catalogue), §7 (retries, circuit breaker) | 2–3 wks | 2 |
| 4 | Policy engine + confirmations + spend reservations | §4 (`policies`, `confirmations`, `spend_reservations`), §6 (confirmation flow + pricing) | 3–4 wks | 3 |
| 5 | Write tools + approver workflow (`list_pending_confirmations`, `confirm_pending`) | §6 (write tools, approver handoff), §7 (idempotency) | 3 wks | 4 |
| 6 | Dashboard (tenant + user + policy + API key + audit viewer) | §3 (`tenants/onboarding`), §4 (`api_keys`, `users`, `oauth_clients`), §5 (RBAC), §8 (audit viewer) | 3–4 wks | 2, 5 |
| 7 | Audit hash chain + object-store flush + tamper-evidence verifier | §4 (`audit_events`, `audit_archives`), §8 (audit log), §9 (compliance) | 2 wks | 1 (can run in parallel with 5/6) |
| 8 | Hardening: rate limits, result-size cap, redaction completeness, soak load, pentest scope | §5 (defense-in-depth), §8 (alerting), §9 (security), §10 (security + soak) | 2–3 wks | 5, 6, 7 |
| 9 | Release engineering: signed images, SBOM, SLSA L2 provenance, IR runbook, DPA template | §9 (supply chain, change mgmt, IR) | 1–2 wks | 8 |

*Effort estimates assume 1–2 mid-to-senior engineers. Calendar time, not person-time. Wide ranges reflect spec-only stage; revise at phase-plan time.

**Total v1: ~5–7 months calendar.**

---

## Phase 1 — Foundation

**Outcome:** A running container that exposes `/healthz`, `/readyz`, accepts a placeholder MCP request, talks to Postgres with RLS enforced, can encrypt/decrypt a secret via KMS envelope, emits structured logs + OTel spans, and ships through a green CI pipeline that produces a signed image.

**In scope**
- Repo restructure under `src/` matching the module map in spec §3 (empty modules with interfaces only where the phase doesn't yet need behaviour).
- `package.json` rewrite with the tech stack above; lockfile committed; `npm ci` in CI.
- Postgres migrations infrastructure (Drizzle migrate or node-pg-migrate). Migration role separate from app role. Initial migrations create `tenants`, `users`, `tenant_keys`, `tenant_secrets`, with RLS policies + revoked DML grants where spec requires.
- `secrets/store` module: envelope-encrypt/decrypt via cloud KMS (AWS KMS or GCP KMS picked at the boundary; the module hides the choice). Fake-KMS shim for tests (LocalStack or hand-rolled).
- `observability/` module: OTel SDK initialized, pino with redaction list, AsyncLocalStorage request context. Redaction list exactly per spec §8.
- `mcp/transport`: Fastify+`@modelcontextprotocol/sdk` Streamable HTTP scaffold that returns `tools/list` with a single placeholder tool and authenticates with a hard-coded dev token (real OAuth lands in Phase 2).
- `auth/identity`: skeleton that returns a typed `Principal` for the dev token; nothing else. Hooks for OAuth and API-key paths exist but throw.
- `/healthz` and `/readyz` per spec §8.
- Dockerfile (multi-stage, distroless, non-root, read-only root FS).
- CI pipeline gates: lint → typecheck → unit → integration (testcontainers Postgres) → build → cosign sign. No e2e yet (no real tool).
- Pre-commit hooks: format, lint, typecheck.
- README replaced with one matching the new architecture; old README archived to `legacy/`.
- Branch `legacy/v0.1` cut from current `main` before any rewrites.

**Out of scope**
- WorkOS OAuth (Phase 2).
- Any real Openprovider call (Phase 3).
- Policies, confirmations, write tools.
- Dashboard.
- Audit hash chain (placeholder `audit_events` table only).

**Exit checklist**
- [ ] `legacy/v0.1` branch pushed; `main` rewritten to new skeleton.
- [ ] `npm ci && npm test` green; coverage ≥ 80% on `secrets/`, `observability/redact`.
- [ ] Integration test asserts RLS denies cross-tenant access on every table introduced.
- [ ] KMS round-trip integration test passes against LocalStack.
- [ ] CI produces a cosign-signed image; SBOM (CycloneDX) attached as a release artifact.
- [ ] `docker run` of that image responds 200 on `/healthz` and 503 on `/readyz` until DB+KMS are wired, then 200.
- [ ] `tools/list` over Streamable HTTP returns the placeholder tool with a dev bearer token.
- [ ] OTel spans visible in a local Jaeger or stdout exporter.
- [ ] CHANGELOG.md created with `0.2.0-phase1` entry.

**Key risks**
- Choosing the cloud provider (AWS vs GCP) shapes KMS, IAM, OIDC federation. Spec says EU default — decide at phase plan time, document in `docs/superpowers/decisions/`.
- Drizzle vs Kysely is a one-way door on type ergonomics; do a 1-day spike during phase planning.

**First-task hint when this phase is planned in detail:**
The first TDD task should be the RLS-cross-tenant integration test against a real Postgres via testcontainers — it locks in the multi-tenant property *before* a single feature line ships. Everything else gets pulled in by the test.

---

## Phase 2 — First end-to-end vertical slice

**Outcome:** A real MCP client (Claude / MCP Inspector) authenticates via WorkOS OAuth and successfully calls `check_domain` (with mocked Openprovider responses) end-to-end. Every step is traced, audited, and tested.

**In scope**
- `auth/oauth`: WorkOS adapter (DCR pass-through, authorization-code + PKCE, token introspection).
- `/.well-known/oauth-protected-resource`.
- `auth/identity`: real OAuth bearer path; API-key path still skeletal.
- `mcp/transport`: full Streamable HTTP semantics — `Mcp-Session-Id`, SSE, error envelopes per spec §7.
- `mcp/tool-dispatch`: argument validation (zod), audit-row insertion, error mapping.
- One tool fully wired: `check_domain` against a Nock-recorded Openprovider response (no live upstream yet).
- `openprovider/client`: only the `check_domain` endpoint; retry + timeout per spec §7.
- `audit_events` insert (no hash chain yet — Phase 7).
- E2E test: spin docker compose with app + Postgres + LocalStack KMS + fake WorkOS + Nock-driven Openprovider; drive via `@modelcontextprotocol/sdk` client.

**Out of scope**
- API keys (Phase 6 with dashboard).
- Live Openprovider integration (Phase 3).
- Other tools.

**Exit checklist**
- [ ] OAuth happy-path E2E test (spec §10 layer 4 scenario #1) passes.
- [ ] Cross-tenant isolation E2E (spec §10 scenario #5) passes — two tenants, parallel sessions, no leakage.
- [ ] Trace propagates end-to-end across `mcp/transport → auth/identity → mcp/tool-dispatch → openprovider/client`.
- [ ] Error contract emits structured codes for: invalid token, validation failure, Nock-injected 5xx, Nock-injected 429.
- [ ] Per-principal rate limits enforced (60 reads/min default).
- [ ] CHANGELOG entry `0.3.0-phase2`.

**Key risks**
- WorkOS DCR conformance with current MCP spec — verify with MCP Inspector early in the phase, not at the end.
- SSE through a managed load balancer — confirm idle-timeout settings before lock-in.

---

## Phase 3 — Openprovider token manager + remaining read tools

**Outcome:** Real WorkOS AuthKit tokens authenticate against the MCP server (not just mocked ones), a tenant onboards their Openprovider credentials (via a CLI for now — dashboard lands in Phase 6), and all read tools work against the live Openprovider sandbox.

**Already delivered early in Phase 2** (the roadmap originally scheduled these here; they shipped with the `check_domain` slice): `openprovider/token-manager` (in-memory + Postgres backstop, singleflight, typed failures), `openprovider_accounts` migration, per-endpoint circuit breaker. Phase 3 extends rather than re-builds them.

**In scope — real AuthKit token authentication (resolves Phase 2 "Gap 2")**

Phase 2 shipped a verifier that *requires* an `act.tnt` claim and derives role from `mcp:read`/`mcp:write` scopes, and was validated only against mocked tokens. Real AuthKit tokens carry neither `act.tnt` nor `mcp:*` scopes (AuthKit's default `scopes_supported` is `email, offline_access, openid, profile`). Phase 3 must close this gap. Decide between:

- **Option A (recommended) — WorkOS Organizations → tenants.** Each tenant maps to a WorkOS organization. The verifier reads the native `org_id` / `organization_id` claim (present in AuthKit tokens once the user authenticates into an organization) instead of a custom `act.tnt`. Add a `workos_org_id` column to `tenants` and an org→tenant lookup in `auth/identity`. Role comes from a persisted `users.role` (the Phase 6 RBAC source, pulled forward to a minimal form here) rather than from scopes.
- **Option B — custom JWT claims + custom scopes.** Configure WorkOS JWT templates to inject `act.tnt` and define custom `mcp:*` scopes in the dashboard. Keeps Phase 2 code as-is; more dashboard config, less portable.

Scope of the auth work:
- Brainstorm A vs B, record the decision in `docs/superpowers/decisions/`.
- Update `createWorkOsVerifier` + `auth/identity` to the chosen claim model.
- Map WorkOS org/tenant → our `tenants.id`; reject tokens whose org has no tenant.
- Update the discovery endpoint's advertised scopes to match what AuthKit actually issues.
- Update unit/e2e fixtures to mint tokens in the real claim shape.
- WorkOS dashboard config: enable Connect → DCR + register the `/mcp` URL as a Resource Indicator (already noted in the Phase 2 plan Task 1).

**In scope — Openprovider read tools + hardening**
- Remaining read tools: `list_domains`, `get_domain`, `list_contacts`, `get_contact`.
- Live sandbox contract tests (spec §10 layer 3 "live sandbox" suite) — opt-in nightly.
- `secrets/store` extended with rotation (re-encrypt under new DEK).
- CLI subcommand `openprovider-mcp tenant:onboard` for ops use until the dashboard exists.
- Cleanups carried from Phase 2: consolidate the duplicated `getDek` into `secrets/dek.ts`; replace the coarse per-bearer rate limit with a per-principal limiter once auth runs as a Fastify preHandler.

**Exit checklist**
- [ ] A real AuthKit-issued token authenticates end-to-end and resolves to the correct tenant (manual test against the sandbox + an automated test using a real-shaped token).
- [ ] Tokens for an org with no mapped tenant are rejected with a clear error.
- [ ] Nightly live-sandbox contract suite green.
- [ ] Token-refresh dead-letter alert wired.
- [ ] Circuit-breaker state metric (`openprovider.circuit_state`) visible.
- [ ] Token refresh under load: 100 concurrent tool calls trigger exactly one upstream login (singleflight verified).
- [ ] `getDek` consolidated; per-principal rate limit replaces the per-bearer one.
- [ ] CHANGELOG entry `0.4.0-phase3`.

**Key risks**
- The auth claim-model decision (A vs B) is the critical path — it touches the verifier, identity resolver, and every auth test. Brainstorm and decide before writing the Phase 3 plan's tasks.
- Openprovider rate limits per reseller account during load testing — coordinate with their support, schedule off-hours.

---

## Phase 4 — Policy engine + confirmations + spend reservations

**Outcome:** A tenant has a JSON policy with TLD lists and a spend cap; a `register_domain` proposal (Phase 5 surface) would succeed or fail deterministically according to it. Concurrent proposals cannot exceed the cap.

**In scope**
- `policies/engine` — pure evaluator over `{tool, args, principal, policy}`.
- `policies`, `confirmations`, `spend_reservations` migrations.
- Pricing module: 24 h `(TLD, period, EUR)` cache; premium-domain bypass; consume-time re-quote with 5% drift guard.
- Confirmation Phase 1 dispatcher per spec §6 — `SELECT ... FOR UPDATE` on `policies` row, pending reservation insert.
- Confirmation Phase 2 dispatcher — hash verify, re-price, reservation commit/release, audit linkage.
- Workers: `confirmations.expire`, `idempotency.expire`, `spend_window.recompute`.
- `list_pending_confirmations` and `confirm_pending` tools (still rejecting actual upstream writes since Phase 5 hasn't shipped — return "dry-run only" until Phase 5).

**Exit checklist**
- [ ] Property test (fast-check) — 1000 concurrent random proposals against a single tenant cap never overshoots.
- [ ] Hash-binding integration test — modifying any byte of args between propose and consume yields `validation_failed`.
- [ ] Drift-guard test — price changes >5% between propose and consume yields `price_changed`.
- [ ] Worker dead-letter alerts wired.
- [ ] CHANGELOG entry `0.5.0-phase4`.

**Key risks**
- Spend-cap atomicity is the highest-risk surface in the whole product. The phase plan must lead with the property test, not the happy-path code.
- Pricing cache invalidation for premium domains — design a kill-switch flag in the policy doc for emergency bypass.

---

## Phase 5 — Write tools + approver workflow

**Outcome:** `register_domain`, `update_domain`, `delete_contact`, `create_contact`, `update_contact` all execute end-to-end with confirmation (and approver handoff where required) against the Openprovider sandbox.

**In scope**
- Wire the remaining Openprovider endpoints into `openprovider/client`.
- Wire the write tools into `mcp/tool-dispatch` with mode `confirm` / `allow` per spec §6.
- Idempotency keys passed to upstream where supported; `idempotency_records` table.
- Approver path fully exercised: a proposer with role `operator` proposes, an `admin`-role principal confirms via `confirm_pending`.
- E2E scenarios 3 (confirmation flow), 4 (policy denial), 6 (401 recovery), 9 (idempotency) from spec §10 layer 4.

**Exit checklist**
- [ ] Sandbox `register_domain` end-to-end via approver flow (no production money spent).
- [ ] Idempotent replay of `create_contact` returns stored result, no duplicate upstream POST.
- [ ] Audit log captures proposer + approver subjects on every confirmed write.
- [ ] CHANGELOG entry `0.6.0-phase5`.

**Key risks**
- Openprovider's idempotency semantics differ by endpoint — phase plan must verify per-endpoint behavior in a spike *before* writing the abstraction.

---

## Phase 6 — Dashboard

**Outcome:** A tenant can self-serve: sign up via WorkOS, paste Openprovider credentials, edit policy JSON (with a guided editor), issue/rotate API keys, browse the audit log, and approve pending confirmations.

**In scope**
- Server-rendered UI (Next.js App Router or Remix — decide at phase plan time). No SPA build pipeline.
- All pages tenant-scoped via the same RLS connection setting used by `/mcp`.
- API-key issuance + argon2 hashing per spec §5.
- Policy editor (text JSON with zod-validation feedback for v1; a structured editor is future work).
- Audit-log viewer with filters; per-tenant NDJSON export endpoint.
- Pending-confirmation list + "Approve & execute" wrapper around `confirm_pending`.

**Exit checklist**
- [ ] Onboarding from "create WorkOS user" to "call `check_domain` from Claude" measured at ≤ 10 minutes.
- [ ] API key issuance test: issue → list (shows prefix only) → use → rotate → use old key fails.
- [ ] Approver E2E: dashboard "Approve & execute" produces the same `audit_events` rows as a programmatic `confirm_pending` call.
- [ ] CHANGELOG entry `0.7.0-phase6`.

**Key risks**
- "Just enough" UI is a slippery scope. Phase plan must list every page and every interaction explicitly.

---

## Phase 7 — Audit hash chain + archives

**Outcome:** `audit_events` has a verifiable hash chain; monthly partitions are sealed to object storage with object-lock; a `verify-chain` CLI walks a tenant's archive and detects any tampering.

**In scope**
- `prev_hash`/`row_hash` columns + insert triggers (or application-layer chain — decide at phase plan).
- Append-only DB grants: `UPDATE`, `DELETE`, `TRUNCATE` revoked on `audit_events`.
- Monthly partitioning.
- `audit.flush` and `audit.partition.seal` workers.
- Object-store integration (S3 or GCS) with object-lock in compliance mode + 7-year retention.
- `verify-chain` CLI in `scripts/`.
- Alert on `audit.chain.broken` log event.

**Exit checklist**
- [ ] Tamper test: edit a row's payload at the DB level (using migration role), worker / verifier detects mismatch and fires alert.
- [ ] Verifier handles partition boundaries correctly (genesis row per partition).
- [ ] Object-lock policy verified end-to-end (attempt to delete an archive object fails with HTTP 403).
- [ ] CHANGELOG entry `0.8.0-phase7`.

**Note:** Phase 7 can run in parallel with Phase 5 or 6 if a second engineer is available — it doesn't depend on write tools or dashboard.

---

## Phase 8 — Hardening

**Outcome:** The service meets every defense-in-depth control in spec §5 and §9, passes a load + soak test, passes a fuzz pass on authz and redaction, and is ready for an external pentest.

**In scope**
- Result-size cap (256 KB post-redaction) + per-PII-tool rate limit (20 calls/hour default).
- IP allowlist enforcement at the policy layer.
- API-key cascade-revoke on user delete (synchronous trigger).
- Global OAuth client → tenant binding via `act.tnt` claim.
- Break-glass DB role + `break_glass_audit` table per spec §9.
- Egress allowlist enforcement at the VPC level (or platform-equivalent).
- Image signature verification at deploy.
- Soak load test (k6, 50 RPS mixed, p95 ≤ §7 budget).
- Authz fuzz (random `(role, scope, tool)` triples).
- PII redaction fuzz (planted secrets across logs/traces/audit).
- Pentest scope finalized + booked.

**Exit checklist**
- [ ] Every defense-in-depth bullet in spec §5 has at least one passing test.
- [ ] Soak load p95 < 2 s for `check_domain` over 30 min.
- [ ] Authz fuzz 10⁶ trials, zero violations.
- [ ] PII fuzz: 100% planted-secret detection across all sink types.
- [ ] Pentest contract signed; scope doc in `docs/superpowers/`.
- [ ] CHANGELOG entry `0.9.0-phase8`.

---

## Phase 9 — Release engineering

**Outcome:** v1.0.0 cut. Customers can sign up. The team has runbooks, a status page, an IR process, and a DPA template ready for procurement conversations.

**In scope**
- cosign signing verified end-to-end in the deploy pipeline.
- SBOM diff on every release; alert on new transitive deps with high+ CVE.
- SLSA L2 provenance attestations via GitHub OIDC.
- IR runbook: detect → contain → eradicate → recover → post-mortem; on-call rotation tooling (PagerDuty or equivalent).
- DPA template + sub-processor list (WorkOS, cloud provider, Openprovider, OTel backend).
- Public security policy + encrypted intake.
- Public status page wired to the SLO alerts from spec §8.
- CHANGELOG → release notes flow.
- v1.0.0 release tagged.

**Exit checklist**
- [ ] Deploy of an unsigned image is rejected by the platform.
- [ ] An intentionally-failed health probe triggers a PagerDuty page within 5 minutes.
- [ ] DPA + sub-processor list reviewed by counsel.
- [ ] v1.0.0 tag pushed; release notes published.

---

## Roadmap maintenance

- This document is the single source of truth for phase sequencing. Changes to phase order, scope, or exit checklists require a PR with rationale and tag relevant codeowners.
- Per-phase detailed plans live in `docs/superpowers/plans/2026-MM-DD-enterprise-mcp-phase-N-*.md`, written via `superpowers:writing-plans` when the phase is scheduled.
- Decision records (cloud provider choice, ORM choice, etc.) live in `docs/superpowers/decisions/`.

---

## Self-review pass

- **Spec coverage:** every section of the spec maps to at least one phase (§1 / §2 → all phases; §3 → 1; §4 → 1, 3, 4, 7; §5 → 2, 4, 8; §6 → 2, 3, 4, 5; §7 → 2, 3, 5; §8 → 1, 7, 8, 9; §9 → 8, 9; §10 → all; §11 → 1; §12 → out-of-scope by design).
- **Placeholder scan:** no "TBD" / "TODO" / unspecified-effort entries. Effort ranges are deliberate at spec-only stage and called out as such.
- **Type / name consistency:** phase exit-checklists name tables and tools verbatim from the spec (`spend_reservations`, `confirm_pending`, `list_pending_confirmations`, `audit_events`, `policies.spend_caps.current_eur`, `act.tnt`). No drift introduced.
- **Phase ordering:** the dependency column matches the prose ordering rules; Phase 7 is explicitly marked as parallelizable.

*End of roadmap.*

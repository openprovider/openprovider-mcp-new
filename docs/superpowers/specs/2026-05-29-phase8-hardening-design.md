# Phase-8 Hardening — Design Spec

- **Status:** Approved (brainstormed 2026-05-29)
- **Goal:** Close the carried-forward hardening backlog on the enterprise Openprovider MCP — 7 items spanning audit-chain test robustness, dashboard auth hardening, an Openprovider error-mapping fix, a read-only `auditor` RBAC role, property-fuzz + soak testing, and supply-chain signing (GHCR push + keyless cosign + SBOM attestation).
- **Scope decision:** ONE mega-spec covering all 7 (per brainstorming). Delivered as one plan → subagent-driven build → single push.
- **Branch:** `feat/enterprise-phase-1` (v0.11.0-api-coverage). Targets a `0.12.0-phase8` release.

---

## 1. Items & decisions (from brainstorming)

| # | Item | Decision |
|---|---|---|
| 1 | audit-chain concurrency-test flake | Diagnose + harden the test (the advisory lock already exists; flake is environmental) |
| 2 | login rate-limit | `@fastify/rate-limit` on `POST /auth/login`, 5/min per IP |
| 3 | OP code-196 mapping | token-manager maps OP error code 196 → `OpenproviderAuthError('invalid Openprovider credentials')` |
| 4 | cookie secure-flag env-gating | `secure` flag gated on `NODE_ENV==='production'`, overridable by `DASHBOARD_COOKIE_SECURE` |
| 5 | break-glass / auditor role | Static read-only `auditor` role (no time-boxed elevation) |
| 6 | soak/fuzz | fast-check property fuzz of security-critical pure fns in CI + manual `autocannon` soak script |
| 7 | cosign/SBOM | GHCR push + keyless `cosign sign` + `cosign attest` the CycloneDX SBOM |

---

## 2. Item 1 — Audit-chain test robustness

**Current state:** `migrations/0010_audit_chain.sql` defines a `BEFORE INSERT` trigger on `audit_events` that calls `pg_advisory_xact_lock(hashtext(NEW.tenant_id::text))`, reads the prior `row_hash`, and computes `NEW.row_hash = sha256(prev_hash || canonical)`. Per-tenant serialization is therefore **already implemented**. The test `tests/integration/db/audit-chain.test.ts` ("concurrent inserts for one tenant produce an unbroken linear chain") passes in isolation (3/3) but intermittently fails under full-suite parallel load.

**Diagnosis (to confirm during implementation — use systematic-debugging):** the symptom (green in isolation, red under parallel suite) points to **connection-pool / container contention**, not a chain-logic defect. The 8 concurrent `runAsTenant` calls each check out a pooled connection; under the full integration suite many test files share the Postgres container, so the advisory-lock-holding transaction can be starved and the test's 30 s budget exceeded, or pool checkout can stall.

**Fix approach:**
1. Reproduce deterministically: run the full integration suite repeatedly to capture an actual failure and confirm whether the assertion that fails is the chain-link assertion (genuine race) or a timeout / pool-exhaustion error (environmental).
2. If environmental (expected): give this test a **dedicated pool** sized to the concurrency (`max >= 8 + headroom`) so its inserts never queue behind unrelated suite traffic, and raise its per-test timeout headroom. Optionally bump concurrency 8 → 16 to prove the lock holds under more pressure.
3. If a genuine race is found (advisory lock not serializing as expected — e.g. `insertEvent` not running each insert in its own transaction so the xact lock releases before the row is visible): fix the insert path to ensure each chained insert runs in a single transaction that holds the lock until commit. Add a regression assertion.

**Acceptance:** the test passes 10/10 consecutive full-integration-suite runs locally.

---

## 3. Item 2 — Login rate-limit

**Current state:** `src/dashboard/server.ts:67` carries `// TODO(phase8): per-IP login rate limit`. `@fastify/rate-limit` is already a dependency (used by the MCP transport).

**Design:** register `@fastify/rate-limit` on the dashboard Fastify instance scoped to the login route only (global: false), with a per-route config on `POST /auth/login`:
- `max: 5`, `timeWindow: '1 minute'`
- `keyGenerator`: client IP (`req.ip`)
- on exceed: HTTP 429 with a JSON `{ error: 'rate_limited' }` body (and the dashboard login page should surface a friendly "too many attempts, try again shortly" message)

The limiter must be registered before the route handlers so it attaches. Successful logins are NOT exempt (a brute-forcer would otherwise probe with valid-looking attempts) — the cap is on attempts regardless of outcome.

**Test:** integration — issue 5 login POSTs from one IP (mix of wrong-password), assert the 6th returns 429; assert a different IP is unaffected.

---

## 4. Item 3 — Openprovider error code 196 mapping

**Current state:** `src/openprovider/token-manager.ts`:
```ts
if (res.status === 401) throw new OpenproviderAuthError('invalid Openprovider credentials');
if (!res.ok) throw new Error(`login failed: ${res.status}`);
```
Openprovider returns bad-credentials not as a clean 401 but as a non-2xx (observed: HTTP 500) whose JSON body carries `{ "code": 196, "desc": "..." }`. That path falls through to the generic `login failed: 500`, which misled debugging earlier this project.

**Design:** after the status checks, parse the response body and inspect the OP `code` field:
- Read the JSON body once (guarded — body may be empty/non-JSON).
- If `body.code === 196` → throw `OpenproviderAuthError('invalid Openprovider credentials')`.
- Also treat the success path defensively: OP sometimes returns HTTP 200 with a non-zero `code`; if `res.ok` but `body.code` is a non-zero auth-failure code (196), throw `OpenproviderAuthError` rather than proceeding with a missing token.
- Otherwise retain the generic `login failed: <status>` for genuinely unexpected failures.

**Test:** unit (no live OP) — mock fetch returning `{ status: 500, json: { code: 196 } }` → expect `OpenproviderAuthError`; mock `{ status: 200, json: { code: 196 } }` → expect `OpenproviderAuthError`; mock a real `{ status: 200, data: { token } }` → returns the token; mock `{ status: 503 }` non-196 → generic error.

---

## 5. Item 4 — Cookie secure-flag env-gating

**Current state:** `src/dashboard/session.ts:24` sets the `op_dash` cookie with `httpOnly: true, sameSite: 'lax', secure: false` (hardcoded).

**Design:** thread a `cookieSecure: boolean` through the dashboard config (`src/config.ts` + the dashboard server deps). Default: `NODE_ENV === 'production'`. Override: explicit env `DASHBOARD_COOKIE_SECURE` (`'true'`/`'false'`) wins when set. The session `setCookie` call uses `secure: cookieSecure`. `httpOnly` and `sameSite: 'lax'` stay as-is.

Rationale for env-gating rather than always-on: local dev + tests run over plain HTTP, where a `secure` cookie is never sent and would break login; production runs behind TLS and must set `secure`.

**Test:** unit — `setSessionCookie` with `cookieSecure: true` emits `secure: true`; with `false` emits `secure: false`. A config unit test: `DASHBOARD_COOKIE_SECURE=true` forces secure even when `NODE_ENV!=='production'`; unset + `NODE_ENV=production` ⇒ secure true; unset + dev ⇒ false.

---

## 6. Item 5 — `auditor` read-only role

**Current state:** roles are `owner | admin | operator | viewer` (`RoleEnum` in `src/policies/schema.ts`, the `Principal` role union in `src/auth/principal.ts`). Two DB CHECK constraints enumerate roles: `migrations/0002_create_users.sql` (`users.role IN ('owner','admin','operator','viewer')`) and `migrations/0012_invitations.sql` (`invitations.role IN ('admin','operator','viewer')`).

**Design:** add a fifth role `'auditor'` — strictly read-only.
- `RoleEnum` and the `Principal` user-role union gain `'auditor'`.
- **Policy-engine gating:** `resolveToolMode(policy, tool, 'auditor')` returns the tool's mode only when `isReadTool(tool)` is true (→ the read tool's `allow`); every non-read tool → `deny`. This is the same gate `viewer` gets — `auditor` is functionally read-only at the tool layer. The distinction is role identity: `auditor` is a separate, assignable, auditable role intended for compliance / break-glass read access, kept distinct from `viewer` (a normal day-to-day role) so future audit-log-read capabilities can gate on `auditor` specifically. The viewer write-gate logic in `evaluate()`/`resolveToolMode` is extended to treat `auditor` identically to `viewer` for tool access (deny all writes/confirms, including allow-mode writes).
- **Migration `0021_auditor_role.sql`:** `ALTER TABLE users DROP CONSTRAINT <users_role_check>, ADD CONSTRAINT ... CHECK (role IN ('owner','admin','operator','viewer','auditor'))`. Also extend the `invitations.role` CHECK to permit inviting an `auditor`. (Use the actual constraint names from the schema; look them up in implementation.) No change to `DEFAULT_POLICY` / `signup_tenant` (auditor is a user role, not a tool).
- **No time-boxed elevation** — explicitly out of scope (decision: static role).

**Tests:** policy-engine unit — `auditor` is denied every representative write/confirm tool (`register_domain`, `create_dns_zone`, `delete_domain`, `create_ssl_order`, …) and allowed read tools (`list_domains`, `get_domain`, `check_domain`, `suggest_domain`). Integration migration test — a freshly migrated DB accepts `role='auditor'` on `users` and `invitations` and rejects a bogus role.

---

## 7. Item 6 — Property fuzz + soak

### Fuzz (CI, `fast-check` — already a dependency)
New property-based test files co-located with the units. Properties:
- **Policy engine** (`src/policies/engine.ts`): for arbitrary policy docs + tool names, a `viewer`/`auditor` is NEVER granted a non-read tool; `evaluate()` never returns `allow` when `liveSpendCents + estimatedCostCents > limit`; `ruleFor` always returns the longest-matching wildcard (generate overlapping wildcard sets).
- **Redaction** (`src/openprovider/redact.ts`): for arbitrary objects containing any of the sensitive keys, the output never contains a sensitive key; redaction is idempotent (`redact(redact(x)) === redact(x)`); safe keys are preserved.
- **Pricing** (`src/policies/pricing/*`): generated valid args never yield a negative cost; a non-EUR currency always throws `UnsupportedCurrencyError`.
- **Canonical args hash** (`src/policies/repo.ts` `canonicalArgsHash`): deterministic for equal objects regardless of key insertion order; different tenant salts yield different hashes.

These run as part of `npm test` (CI). Keep iteration counts modest (e.g. `fc.assert(..., { numRuns: 200 })`) to bound CI time.

### Soak (manual, NOT CI)
`scripts/soak.mjs` using `autocannon` (new devDep): drives a running local server's `/mcp` with repeated `tools/list` (a benign authenticated read) for a configurable duration (default 60 s) and concurrency, printing p50/p99 latency and process RSS at start vs end to surface leaks/degradation. Documented in the README under a "Soak testing" heading; invoked via `node scripts/soak.mjs --duration 60 --connections 20 --token <dev-bearer>`. Not wired into CI (load tests are environment-sensitive and slow).

---

## 8. Item 7 — GHCR push + keyless cosign + SBOM attestation

**Current state:** `.github/workflows/ci.yml` `build` job already: builds the image, generates a CycloneDX SBOM (`anchore/sbom-action`), uploads it as an artifact, and installs `cosign`. The `cosign sign` step is deferred with a comment ("requires a registry-pushed image … deferred to phase 9") because no registry is wired. The repo has a `Dockerfile`. The workflow already declares `permissions: id-token: write` (keyless OIDC ready).

**Design:** complete the supply-chain step using **GitHub Container Registry (GHCR)** — free, no external creds, works with the built-in `GITHUB_TOKEN`.
- Add `packages: write` to the workflow `permissions`.
- Gate the push/sign on trusted refs only: `github.ref == 'refs/heads/main'` or a tag push (`refs/tags/*`). PRs from forks build the image + SBOM but do NOT push/sign (no registry write, and OIDC identity differs).
- Steps in the `build` job (or a dedicated `release` job triggered on tags):
  1. `docker/login-action` to `ghcr.io` with `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}`.
  2. Build + push `ghcr.io/<owner>/openprovider-mcp` tagged with the commit SHA (and the git tag on tag pushes). Capture the pushed image **digest**.
  3. `cosign sign --yes ghcr.io/<owner>/openprovider-mcp@<digest>` — keyless (Fulcio/Rekor via the OIDC token). No private keys stored.
  4. Generate the CycloneDX SBOM for the pushed image (existing step), then `cosign attest --yes --predicate sbom.cdx.json --type cyclonedx ghcr.io/<owner>/openprovider-mcp@<digest>`.
  5. **Verify-in-CI** step: `cosign verify` (with the expected OIDC issuer + identity regexp) and `cosign verify-attestation` against the digest, proving the signature + SBOM attestation validate. This is the test for this item.

**Note (the local no-op):** keyless signing needs the GitHub Actions OIDC context, so none of the sign/verify steps run locally — this item is verified in CI only. The implementation task's "test" is a green CI run on a branch push to a fork that has GHCR + OIDC available, or a documented manual `act`/dry-run. Locally we only lint the workflow YAML.

---

## 9. Delivery & sequencing

One plan, subagent-driven, single push at the end. Suggested task breakdown (9 tasks):
1. Item 3 — token-manager code-196 mapping (unit). *(smallest, isolated)*
2. Item 4 — cookie secure env-gating (config + session + unit).
3. Item 2 — login rate-limit (dashboard + integration).
4. Item 5 — `auditor` role (RoleEnum + principal + policy engine + migration 0021 + unit/migration tests).
5. Item 1 — audit-chain test robustness (diagnose; dedicated pool / fix; 10× stability check).
6. Item 6a — fast-check property fuzz suites (engine, redaction, pricing, hash).
7. Item 6b — `autocannon` soak script + README.
8. Item 7 — CI: GHCR push + cosign sign + SBOM attest + verify.
9. Release bump to `0.12.0-phase8` + CHANGELOG.

Each task is TDD where testable; item 7 is CI-only-verified; item 1 is investigation-led.

---

## 10. Out of scope (restated)
- Time-boxed break-glass elevation (item 5 is the static role only).
- HTTP-level fuzzing / live-dispatcher soak in CI (item 6 soak is a manual script).
- External container registries beyond GHCR; signing-key management (keyless only).
- Retroactive re-signing of prior releases.
- The known cosmetic nits (`serverInfo.version` literal, `deleteTag` toQuery, `updateDnsZone` redundant `domain`) — tracked separately, not part of Phase-8.

---

*End of spec.*

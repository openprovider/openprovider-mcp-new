# Phase 4 — Policy Engine + Confirmations + Spend Reservations — Design Spec

- **Status:** Approved (brainstormed 2026-05-26)
- **Scope:** The policy/confirmation/spend-reservation **engine** and its supporting surfaces (pricing, policy default + CLI, the two meta-tools), proven via a synthetic confirm-mode test tool. The real write tools (`register_domain`, `update_domain`, `delete_contact`, `update_contact`, `create_contact`) + idempotency records are **Phase 5**.
- **Parent spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §4, §6.
- **Roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md` § Phase 4.
- **Builds on:** Phases 1–3 (`feat/enterprise-phase-1`): RLS, secrets, dispatcher, audit, auth with `resolve_or_provision_tenant`, openprovider client/token-manager.

---

## 1. Decisions taken in brainstorming

1. **No workers in Phase 4 (lazy model).** Live spend is computed from `spend_reservations` at check time; expired pending reservations fall out of the SUM via an `expires_at > now()` filter, so no active sweep is needed for correctness. pg-boss is deferred to Phase 7/8.
2. **Policy default-on-provision + CLI.** A safe default policy (spend cap €0 → billable writes blocked until raised) is seeded when a tenant is provisioned; a `policy:set`/`policy:show` CLI edits the JSON. Dashboard editing is Phase 6.
3. **Synthetic confirm-mode test tool.** Phase 4 ships the generic confirm machinery + the real `list_pending_confirmations`/`confirm_pending` meta-tools, exercised by a test-only confirm-mode tool. Real write tools are Phase 5.

---

## 2. Schema — migration 0008

All three tables are RLS-scoped (`tenant_id = current_setting('app.current_tenant', true)::uuid`, `FORCE ROW LEVEL SECURITY`, `GRANT SELECT, INSERT, UPDATE` to `app_role`; `confirmations`/`spend_reservations` also get the standard isolation policy).

```sql
CREATE TABLE policies (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  doc                jsonb NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid
);

CREATE TABLE confirmations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  principal_subject      text NOT NULL,
  tool_name              text NOT NULL,
  args_hash              bytea NOT NULL,
  args_jsonb             jsonb NOT NULL,          -- redacted copy for approver rendering
  summary_text           text NOT NULL,
  estimated_cost_eur     numeric(12,4) NOT NULL DEFAULT 0,
  required_approver_roles text[] NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz
);
CREATE UNIQUE INDEX confirmations_active_id ON confirmations (id) WHERE consumed_at IS NULL;
CREATE INDEX confirmations_tenant_expiry ON confirmations (tenant_id, expires_at);

CREATE TABLE spend_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  confirmation_id uuid REFERENCES confirmations(id),
  amount_eur      numeric(12,4) NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','released')),
  window_start    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz
);
CREATE INDEX spend_reservations_window ON spend_reservations (tenant_id, window_start, status);
```

Journal entry `idx: 7, tag: 0008_policies_confirmations_reservations`.

**`numeric` handling:** `pg` returns `numeric` as a string. The repo layer parses `amount_eur`/`estimated_cost_eur` with a small `parseEur(s) → number` helper and writes numbers as strings; all money math is done in integer **cents** internally to avoid float drift (`Math.round(eur * 100)`), converting back to EUR at the boundary.

**`policies.spend_caps.current_eur`:** informational only in Phase 4. Live spend is computed from `spend_reservations` (§4), not from this field. It exists in the policy JSON for forward-compat with the Phase 7 worker rollup; Phase 4 never reads it for decisions.

---

## 3. Policy document shape + default

Validated by a zod schema `PolicyDoc` in `src/policies/schema.ts`:

```jsonc
{
  "version": 1,
  "spend_caps": { "window": "month", "limit_eur": 0 },
  "tld_allowlist": [],          // empty = all TLDs allowed (subject to denylist)
  "tld_denylist": [],
  "tools": {
    "list_*": "allow", "get_*": "allow", "check_domain": "allow",
    "register_domain": "confirm", "update_domain": "confirm",
    "delete_contact": "confirm", "update_contact": "confirm",
    "create_contact": "allow"
  },
  "ip_allowlist": []
}
```

- Each `tools` value is **either** a bare mode string (`"allow"` | `"confirm"`) **or** an object `{ "mode": "allow"|"confirm", "approvers"?: Role[] }`. The bare-string form means "use the default approver roles" for confirm mode. zod: `z.union([ModeEnum, z.object({ mode: ModeEnum, approvers: z.array(RoleEnum).optional() })])`.
- **`required_approver_roles`** for a confirm-mode tool = the tool's `approvers` if the object form is used, else the default **`['owner','admin']`**. This value is captured into the `confirmations` row at propose time. (In the Phase 3 individual-user model every tenant has one `owner`, who always satisfies the default — so solo tenants self-confirm. Multi-user approver separation becomes meaningful once Phase 6 adds user invitation.)
- `window`: `'month'` only in Phase 4 (`'day'`/`'week'` deferred). `window_start` = `date_trunc('month', now())` at UTC.
- Tool keys support a trailing `*` wildcard (`list_*`, `get_*`); exact keys win over wildcards. Wildcard values are bare mode strings only (no approver objects on wildcards).
- **Default seeded on provision:** the above with `limit_eur: 0`. Billable writes (estimated cost > 0) are therefore denied until the owner raises the cap via the CLI — safe by default. Non-billable confirm-mode tools still work through the confirm path.

---

## 4. `policies/engine` — pure decision module

`src/policies/engine.ts`:

```ts
export type Decision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'requires_confirmation' };

export function evaluate(input: {
  toolName: string;
  args: unknown;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  policy: PolicyDoc;
  liveSpendCents: number;        // from §5, computed by the caller
  estimatedCostCents: number;    // from pricing (§6)
  tldsInArgs: string[];          // extracted by the caller for domain tools
}): Decision;
```

Pure, no I/O. Order of checks:
1. Resolve the tool's mode from `policy.tools` (exact key, else wildcard, else default `deny`).
2. Role gate: `viewer` may only invoke `allow`-mode read tools; `operator`/`admin`/`owner` may invoke writes (finer role rules are Phase 6 RBAC).
3. TLD gate (domain tools only): every TLD in `tldsInArgs` must pass denylist (not in it) and allowlist (empty allowlist = all allowed).
4. Spend gate (billable tools): `liveSpendCents + estimatedCostCents ≤ limit_eur*100`. Fail → `deny('spend_cap_exceeded')`.
5. If mode is `allow` and all gates pass → `allow`. If mode is `confirm` → `requires_confirmation`.

Unit + property tests: cap math is monotonic; decision is independent of `tools` key insertion order; wildcard vs exact precedence.

---

## 5. Spend accounting — lazy + atomic

The money-critical surface. All within the per-request transaction (already `BEGIN` + `SET LOCAL ROLE app_role` + tenant GUC from the dispatchFactory).

**Live spend query** (current window):
```sql
SELECT COALESCE(SUM(amount_eur), 0) AS live
  FROM spend_reservations
 WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
   AND window_start = date_trunc('month', now())
   AND (status = 'committed' OR (status = 'pending' AND
        confirmation_id IN (SELECT id FROM confirmations WHERE expires_at > now() AND consumed_at IS NULL)));
```
(Equivalently a join; the implementation may join `spend_reservations` to `confirmations` on `confirmation_id` and filter — pick the form that's clearest and indexed.)

**Propose (mode = confirm, no token):**
1. `SELECT … FOR UPDATE FROM policies WHERE tenant_id = $` — serializes concurrent proposals for this tenant.
2. Compute `liveSpendCents` via the query above.
3. Price the op (§6) → `estimatedCostCents`.
4. `evaluate(...)`. If `deny` → structured error (`policy_denied` with reason). If `requires_confirmation`:
   - INSERT `confirmations` (args_hash = sha256(canonical(args) || tenantId), redacted `args_jsonb`, summary, `estimated_cost_eur`, `required_approver_roles` = the tool's `approvers` override or the default `['owner','admin']` per §3, `expires_at = now() + ttl`).
   - INSERT `spend_reservations` (`pending`, `amount_eur = estimatedCost`, `window_start = date_trunc('month', now())`, `confirmation_id`).
5. Return `confirmation_required` payload.

**Consume (token present):**
1. Load confirmation by token-derived id (`confirm_pending` passes `confirmation_id`). Missing → `confirmation_not_found`.
2. Verify `args_hash` matches supplied args (`validation_failed` on mismatch), `consumed_at IS NULL` + `expires_at > now()` (`confirmation_expired`), caller role ∈ `required_approver_roles` (`approver_role_required`).
3. Re-price; if `newCents > estimatedCents * 1.05` → `price_changed` (reservation flips `released`, confirmation left unconsumed so a fresh propose is required).
4. Execute the tool handler. On success: `confirmations.consumed_at = now()`, reservation `pending → committed` (`settled_at = now()`). On upstream failure: reservation `pending → released`, confirmation left unconsumed; error surfaced.
5. Audit rows for propose and consume linked by `confirmation_id`.

**Concurrency invariant (marquee test):** N concurrent proposals against a near-full cap must never let committed+pending exceed `limit_eur`. The `SELECT … FOR UPDATE` on the `policies` row serializes the read-compute-insert, so each proposal sees prior pending holds. Integration test asserts no overshoot across 10+ concurrent proposals.

---

## 6. Pricing + drift guard

`src/policies/pricing.ts`: `createPricing({ client })` → `price(toolName, args, token) → { cents: number }`.
- `register_domain`/`update_domain`: call `client.checkDomain(token, {domains, with_price:true})`, read the per-TLD price, sum across the domains in args, convert to cents.
- Cache per `(tld, period, 'EUR')` for 24h (in-memory Map with timestamp). **Premium domains** (`is_premium === true` in the check response) bypass the cache — always re-quoted.
- Non-EUR upstream price → throw `unsupported_currency`.
- Non-billable confirm tools (`delete_contact`, `update_contact`) → `cents: 0`.
- The **synthetic test tool** supplies a fixed price via an injected pricer, so Phase 4 tests the propose/consume/drift logic without Phase 5's register_domain. The real `checkDomain` pricing path is covered via Nock.

---

## 7. Confirmation wiring in the dispatcher

`src/mcp/dispatch.ts` gains confirm-mode handling, parameterized by injected collaborators (so it stays testable without a DB):

```ts
interface ConfirmDeps {
  getPolicy: (tenantId: string) => Promise<PolicyDoc>;
  liveSpendCents: (tenantId: string) => Promise<number>;
  price: (toolName: string, args: unknown, principal: Principal) => Promise<number>;
  propose: (input: ProposeInput) => Promise<ConfirmationRecord>;   // FOR UPDATE + inserts
  consume: (input: ConsumeInput) => Promise<void>;                 // verify + commit/release
}
```

Flow: if the tool's policy mode is `confirm` and the call has no `confirm` token → run propose, return `confirmation_required`. If it has `confirm: { token }` → run consume, then execute the handler. `allow`-mode tools run as today (Phase 2/3). The dispatcher does not itself open transactions — `server.ts`'s dispatchFactory provides the transaction-scoped collaborators, mirroring the Phase 2 pattern.

`tools/call` argument extension: `{ ...toolArgs, confirm?: { token: string } }`. The `confirm` field is stripped before the tool's zod schema validates `toolArgs`.

---

## 8. Meta-tools (shipped this phase)

- **`list_pending_confirmations`** (read, `allow`): returns `{ confirmation_id, tool_name, summary_text, args_jsonb, estimated_cost_eur, proposer_subject, created_at, expires_at }[]` for confirmations where `consumed_at IS NULL`, `expires_at > now()`, and the caller's role ∈ `required_approver_roles`. **No tokens returned.**
- **`confirm_pending`** (meta): `confirm_pending(confirmation_id, args)` recomputes the args hash against supplied args, then runs the consume path. The future dashboard "Approve & execute" wraps this. Gated by the confirmation's `required_approver_roles`.

Both are registered in `server.ts` alongside the read tools.

---

## 9. Policy default + CLI

- **Default on provision:** extend `resolve_or_provision_tenant` (migration 0008 replaces the function body) so that immediately after inserting a new `users` row it also `INSERT`s the default `policies` row for the new tenant. Idempotent: existing tenants are untouched (the function only provisions on the first-login path). Existing tenants without a policy get one lazily — `getPolicy` returns the default (and persists it) if no row exists.
- **`scripts/policy.ts` CLI:** `policy:show --tenant <uuid>` prints the current doc; `policy:set --tenant <uuid> --file policy.json` validates against `PolicyDoc` (zod) and upserts, bumping `version`. Runs under `app_role` + tenant GUC like `tenant:onboard`.

---

## 10. Test strategy

**Unit:** `policies/engine` (allow/deny/confirm, TLD allow+deny, role gate, cap math) + property tests (monotonic cap, order-independent tools map, wildcard precedence); `pricing` (cache hit/miss, premium bypass, unsupported_currency, drift threshold); confirmation `args_hash` binding (order-insensitive, any byte change invalidates).

**Integration (testcontainers):**
- **Concurrent-overshoot (marquee):** raise cap to e.g. €100; fire 10 concurrent proposals each costing €15 via the synthetic tool; assert exactly `floor(100/15)=6` succeed as `pending` and the rest are `policy_denied`; committed+pending never exceeds €100.
- propose → `confirm_pending` (by an approver role) → committed; reservation transitions correct.
- expiry: propose, advance clock past TTL, consume → `confirmation_expired`; the expired pending reservation no longer counts toward live spend.
- double-consume → second attempt `confirmation_not_found`/already-consumed.
- approver-role enforcement: proposer with `operator` role, `required_approver_roles=['owner','admin']` → `confirm_pending` by `operator` rejected, by `owner` accepted.
- default-policy seeding: a freshly provisioned tenant has the default policy; `limit_eur:0` blocks a billable proposal with `policy_denied`.
- RLS on `policies`/`confirmations`/`spend_reservations`.

**E2E (extend the suite):** tenant with cap raised via `policy:set` → synthetic confirm tool → `confirmation_required` → `confirm_pending` → committed; tenant at default `limit_eur:0` → `policy_denied`.

---

## 11. File structure

| File | Responsibility |
|---|---|
| `migrations/0008_policies_confirmations_reservations.sql` | 3 tables + RLS + grants; replaces `resolve_or_provision_tenant` body to seed default policy |
| `src/policies/schema.ts` | `PolicyDoc` zod schema + `DEFAULT_POLICY` |
| `src/policies/engine.ts` | pure `evaluate(...)` |
| `src/policies/pricing.ts` | `createPricing({client})` + 24h cache + drift constant |
| `src/policies/repo.ts` | `getPolicy`, `upsertPolicy`, `liveSpendCents`, `insertConfirmationWithReservation` (FOR UPDATE), `consumeConfirmation` |
| `src/mcp/dispatch.ts` (mod) | confirm-mode branch using injected `ConfirmDeps` |
| `src/tools/list-pending-confirmations.ts`, `confirm-pending.ts` | meta-tools |
| `src/server.ts` (mod) | wire `ConfirmDeps` into dispatchFactory; register meta-tools |
| `scripts/policy.ts` | `policy:show` / `policy:set` CLI |
| `tests/...` | unit + integration + e2e per §10 |

---

## 12. Out of scope (Phase 5+)

- Real write tools (`register_domain`, `update_domain`, `delete_contact`, `update_contact`, `create_contact`) and their idempotency records.
- pg-boss workers (confirmation sweep, spend-window rollup) — Phase 7/8.
- `day`/`week` spend windows.
- Dashboard policy editor — Phase 6.
- Per-approver notification/inbox UX beyond `list_pending_confirmations`.

---

*End of spec.*

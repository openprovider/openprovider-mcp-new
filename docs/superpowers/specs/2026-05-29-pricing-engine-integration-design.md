# Pricing-Engine Integration — Design Spec

- **Status:** Approved (brainstormed 2026-05-29)
- **Goal:** Wire real Openprovider pricing into `src/policies/pricing.ts` for the 7 confirm-mode billable tools currently bypassing the spend-cap, so `spend_caps.limit_eur` actually gates them. (`trade_domain` stays confirm-without-spend — documented; no OP price source available.)
- **Source endpoints:** `getDomainPrice` (Batch 3, Domain Price Service), `listSslProducts` (Batch 4), `listLicensePrices` (Batch 7).
- **Stacks on:** `feat/enterprise-phase-1` after Batch 7 (HEAD `e4042a5`).
- **Migration stance:** HARD CUTOVER. Tenants whose `spend_caps.limit_eur` was set under the prior (free) behavior must raise it or confirmations will be denied with `decision: deny, reason: spend_cap_exceeded`. Stated in CHANGELOG.

---

## 1. Decisions (from brainstorming)

1. **Scope:** one consolidated spec covering all 3 price sources (domain operation, SSL, Plesk license).
2. **Migration:** hard cutover. No SQL migration. CHANGELOG documents the breaking change.
3. **`trade_domain`:** stays confirm-without-spend (no source endpoint). Documented limitation.
4. **Response-shape uncertainty:** best-guess shapes derived from documented related endpoints (`checkDomain`'s `price.product` shape, SSL `prices[]` from Postman collection) + env-gated **live integration tests** (matching the existing `live-contacts.test.ts` pattern) that hit real OP to confirm parsers against the API.
5. **Failure mode:** any pricer error THROWS (no silent fallback to 0). `propose()` already catches and returns an audit-logged dispatch error, blocking the confirmation. This preserves the cap gate.

---

## 2. Architecture

The existing single-file `src/policies/pricing.ts` (~70 lines, hard-codes `register_domain`/`update_domain`) is restructured into a `src/policies/pricing/` directory with one sub-pricer per source:

```
src/policies/pricing/
  index.ts          # createPricing({ client }) — builds a Map<toolName, Pricer>
  domain-check.ts   # register_domain, update_domain (existing logic moved here verbatim)
  domain-op.ts      # renew_domain, transfer_domain, restore_domain (NEW)
  ssl-order.ts      # create_ssl_order, renew_ssl_order, reissue_ssl_order (NEW)
  plesk-license.ts  # create_plesk_license (NEW)
  currency.ts       # UnsupportedCurrencyError (promoted from current pricing.ts)
```

`src/policies/pricing.ts` becomes a thin re-export (`export * from './pricing/index.js'`) so call sites (`src/server.ts`, `tests/**/*-e2e.test.ts`) do not churn.

The public `Pricing` interface is unchanged:
```ts
export interface Pricing {
  price(toolName: string, args: unknown, token: string): Promise<number>;
}
```
`createPricing(deps)` builds the dispatch map at construction. `price(toolName, args, token)` is a one-line lookup: `const p = map.get(toolName); return p ? p.price(args, token) : 0`. Each sub-pricer exposes the internal interface:
```ts
interface Pricer {
  price(args: unknown, token: string): Promise<number>;
}
```
Sub-pricers drop `toolName` from their signature — the dispatch map already resolved it, and multi-tool sub-pricers are **parameterized at construction** with the discriminator they need. Concretely:
- `createDomainCheckPricer({ client })` — one instance, registered for both `register_domain` and `update_domain` (same `checkDomain` call shape).
- `createDomainOpPricer({ client, operation: 'renew' | 'transfer' | 'restore' })` — three instances built, one per operation, each registered to its tool name.
- `createSslOrderPricer({ client, mode: 'create' | 'renew' | 'reissue' })` — three instances, one per mode. `mode === 'renew'` is the only one that performs the `getSslOrder` lookup; the other two read args directly.
- `createPleskLicensePricer({ client })` — one instance, registered only for `create_plesk_license`.
This keeps each sub-pricer ignorant of tool names; the wiring lives in `index.ts`.

**Caching:** each sub-pricer owns a 24h cache (`CACHE_TTL_MS` is shared).
- `domain-check`: key `${extension}|${period}|EUR`; premium domains skip the cache (existing rule).
- `domain-op`: key `${operation}|${extension}|${period}|EUR`; premium domains skip the cache.
- `ssl-order`: caches the full `listSslProducts()` response (one call, ~50 products); price formula computed in-memory per call.
- `plesk-license`: caches the full `listLicensePrices()` response; per-SKU price extracted on each call.

**Currency:** EUR-only stays. Non-EUR throws `UnsupportedCurrencyError`. Future work.

**Errors:** any sub-pricer throws on (a) 5xx / network failure from OP, (b) missing expected field in the response, (c) non-EUR currency, (d) unknown SKU / product_id / period mismatch. Throws propagate up through `propose()` → the dispatcher returns a dispatch-error response and the confirmation is NOT created. No silent fallback to 0.

---

## 3. Per-pricer formulas

### `domain-check.ts` — `register_domain`, `update_domain`

Existing logic, moved verbatim. Calls `client.checkDomain(token, { domains: [{ name, extension }], with_price: true })`. Total = `eurToCents(results[0].price.product.price) × period`. Premium domains skip cache. EUR-only.

### `domain-op.ts` — `renew_domain`, `transfer_domain`, `restore_domain` (NEW)

Tool → operation mapping:

| tool | operation |
|---|---|
| `renew_domain` | `renew` |
| `transfer_domain` | `transfer` |
| `restore_domain` | `restore` |

Calls `client.getDomainPrice(token, { domain, operation })`. Assumed response shape (matches `checkDomain` convention; live test confirms):
```ts
{ price: { product: { currency: 'EUR', price: 9.99 }, reseller: {...} }, is_premium?: boolean }
```
Total = `eurToCents(data.price.product.price) × (args.period ?? 1)`. The `period` is taken from args for `renew_domain` (its schema requires `period`); for `transfer_domain`/`restore_domain` (which don't have `period` in their schemas) we default to 1 year (the natural OP unit).

Cache keyed `${operation}|${extension}|${period}|EUR`. Premium (`is_premium === true`) skips the cache.

`trade_domain` is NOT registered in the dispatch map — it falls through to the `0` default. Documented.

### `ssl-order.ts` — `create_ssl_order`, `renew_ssl_order`, `reissue_ssl_order` (NEW)

Sub-pricer caches the full `listSslProducts()` response for 24h.

Price formula given `(product_id, period, domain_amount, wildcard_domain_amount)`:
1. `product = products.find(p => p.id === product_id)` — throw `unknown_ssl_product` if not found.
2. `entry = product.prices.find(e => e.period === period)` — throw `unsupported_period` if not found.
3. Assert `entry.price.product.currency === 'EUR'` — throw `UnsupportedCurrencyError` otherwise.
4. `base = eurToCents(entry.price.product.price)`.
5. If `domain_amount > 1`: `extra = (domain_amount - 1) × eurToCents(entry.extra_domain_price.product.price)` (skip if `extra_domain_price` missing → throw `unsupported_extra_domains` only if `domain_amount > 1`).
6. If `wildcard_domain_amount > 0`: `wildcardExtra = wildcard_domain_amount × eurToCents(entry.extra_wildcard_domain_price.product.price)` (skip if missing → throw `unsupported_wildcards` only if `wildcard_domain_amount > 0`).
7. Total = `base + extra + wildcardExtra`.

Per-tool input resolution:
- `create_ssl_order`: args include `product_id`, `period`, `domain_amount`, `wildcard_domain_amount` → direct.
- `reissue_ssl_order`: same body shape as create → direct.
- `renew_ssl_order`: args only carry `{ id, enable_dns_automation }`. Call `client.getSslOrder(token, id)` to discover `product_id`, `period`, `domain_amount`, `wildcard_domain_amount` from the order, then price. The `getSslOrder` call is NOT cached (each id may differ); this adds one OP round-trip (~150ms) to the propose path. Acceptable. Future optimization: change `RenewSslOrderArgs` schema to optionally carry product/period to skip the lookup.

### `plesk-license.ts` — `create_plesk_license` (NEW)

Sub-pricer caches the full `listLicensePrices()` response for 24h.

Assumed response shape:
```ts
[{ sku: string, prices: [{ period: number, price: { product: { currency, price }, reseller } }] }]
```
Live test confirms.

Price formula given `(items: string[], period: number)`:
1. For each `sku` in `items`: `entry = list.find(p => p.sku === sku)` — throw `unknown_license_sku` if not found.
2. `periodEntry = entry.prices.find(e => e.period === period)` — throw `unsupported_period` if not found.
3. Assert EUR.
4. `cents += eurToCents(periodEntry.price.product.price)`.
5. Return sum.

`update_plesk_license` (allow-mode), `reset_plesk_hwid` (allow-mode), `delete_plesk_license` (confirm-mode, destructive) are NOT priced — they're not in `BILLABLE` and the `price()` dispatch returns `0` for them.

---

## 4. Spend-cap behavior summary

After this spec lands:

| Tool | Mode | Pricing |
|---|---|---|
| `register_domain`, `update_domain` | confirm | priced (existing) |
| `renew_domain`, `transfer_domain`, `restore_domain` | confirm | **priced (NEW)** |
| `trade_domain` | confirm | **0** (no price source — documented) |
| `delete_domain` | confirm | 0 (destructive) |
| `restart_domain_operation` | confirm | 0 |
| `create_ssl_order`, `renew_ssl_order`, `reissue_ssl_order` | confirm | **priced (NEW)** |
| `cancel_ssl_order` | confirm | 0 (destructive) |
| `create_plesk_license` | confirm | **priced (NEW)** |
| `delete_plesk_license`, `delete_dns_zone`, `delete_*` | confirm | 0 (destructive) |

**Drift:** the existing `validateConfirmation` (in `src/policies/repo.ts` / dispatcher) re-prices on consume and rejects if `fresh > round(stored × 1.05)`. New pricers inherit this for free.

---

## 5. Tasks (per the implementation plan that follows)

1. **Refactor scaffolding** — split `pricing.ts` into the `pricing/` directory; move `register_domain`/`update_domain` verbatim into `domain-check.ts`; hoist `UnsupportedCurrencyError` to `pricing/currency.ts`; keep `pricing.ts` as a re-export. Zero behavior change; existing tests stay green.
2. **Domain operation pricer** — `domain-op.ts` + unit tests (Nock) + dispatch-map registration + env-gated live test.
3. **SSL order pricer** — `ssl-order.ts` + unit tests + products-list cache + `getSslOrder` lookup for renew + env-gated live test.
4. **Plesk license pricer** — `plesk-license.ts` + unit tests + prices-list cache + env-gated live test.
5. **Confirm-flow integration test + CHANGELOG** — `tests/integration/policies/pricing-confirm.test.ts` covering all priced tools (incl. cap-exceedance denial) and `trade_domain` confirm-without-spend; CHANGELOG hard-cutover notice.

Single push at the end.

---

## 6. Testing

**Unit tests** (`src/policies/pricing/*.test.ts`, Vitest + Nock):
- One file per sub-pricer.
- Each covers: happy path, cache hit (2nd call doesn't re-fetch), non-EUR throws, missing field throws, 5xx throws, TTL expiry re-fetches.
- `domain-op.ts`: per-operation Nock test (renew/transfer/restore). Asserts query params `domain.name`, `domain.extension`, `operation` match expected.
- `ssl-order.ts`: formula end-to-end (base + extra_domain + wildcard) using a fixture products-list. Plus `renew_ssl_order` path with one fixture for `getSslOrder` returning `{ product_id, period, domain_amount, wildcard_domain_amount }`.
- `plesk-license.ts`: SKU sum (multiple items in one call), period mismatch throws.
- Existing `pricing.test.ts` is split: `register_domain`/`update_domain` tests move to `domain-check.test.ts`. Shared `clientWith()` fixture hoisted to `src/policies/pricing/__fixtures/op-client.ts`.

**Integration tests** (`tests/integration/policies/pricing-confirm.test.ts` — new):
- Boots Postgres + Fastify, seeds tenant with default policy.
- Per priced tool: proposes confirmation with a mocked `OpenproviderClient`, asserts `summary` text includes `est. €X.YY`, asserts `estimatedCostCents` is non-zero.
- `trade_domain` proposal: asserts `est. €0.00` (confirm-without-spend).
- Cap-exceedance denial: tenant with `spend_caps.limit_eur = 5` calls `renew_domain` priced at €15 → `evaluate()` returns `decision: 'deny', reason: 'spend_cap_exceeded'`.
- Drift rejection: proposes with one price, mock returns 1.10× on consume → confirmation rejected with `validation_failed` / `price_changed`.

**Live integration tests** (env-gated, skip unless `OP_LIVE_USERNAME` is set):
- `tests/integration/openprovider/live-domain-price.test.ts` — calls `getDomainPrice` for a known TLD with each of `renew|transfer|restore`. Asserts response carries `price.product.currency === 'EUR'` and numeric `price.product.price`.
- `tests/integration/openprovider/live-ssl-products.test.ts` — calls `listSslProducts`. Asserts at least one product carries `prices[]` with `period`, `price.product.price`, and the extra-domain/wildcard fields shaped as we read them.
- `tests/integration/openprovider/live-license-prices.test.ts` — calls `listLicensePrices`. Asserts at least one entry carries `sku` and `prices[]` with the per-period EUR price.

CI stays green (live tests skipped by default). Local dev runs them once after merging to verify parsers against real OP.

**No per-batch e2e changes** — existing dispatch e2e tests don't assert price values, so they're unaffected.

---

## 7. Risks & mitigations

- **Shape mismatch with real OP:** live integration tests catch this post-merge. Fix is local to one sub-pricer.
- **`getSslOrder` latency in `renew_ssl_order` propose path:** adds one OP round-trip (~150ms). Acceptable; documented; future-optimizable by carrying product/period in args.
- **Premium pricing:** `getDomainPrice` may return higher prices for premium names. Pricer returns what OP says — consumes more cap. `is_premium === true` results bypass the cache (same convention as `domain-check.ts`).
- **SSL/Plesk catalog staleness:** 24h cache. Intra-day price change: next propose uses stale; consume re-prices and rejects on drift > 5%. Self-healing in the worst case.
- **Hard-cutover surprise:** tenants whose caps were set assuming the 7 tools were free will see denials. Mitigation: CHANGELOG entry quoted verbatim in the release notes; advise pre-flight cap review.

---

## 8. CHANGELOG entry (verbatim)

> **BREAKING (operator-visible):** `renew_domain`, `transfer_domain`, `restore_domain`, `create_ssl_order`, `renew_ssl_order`, `reissue_ssl_order`, `create_plesk_license` now consume from the tenant's `spend_caps.limit_eur` (previously they were priced at 0 and bypassed the cap). Tenants whose cap was set under the prior behavior should raise it before performing these operations or confirmations will be denied with `decision: deny, reason: spend_cap_exceeded`. `trade_domain` remains confirm-without-spend (no public Openprovider price source is available for the trade operation).

---

## 9. Out of scope (restated)

- Non-EUR currency support (stays `UnsupportedCurrencyError`).
- `price.reseller` (customer-specific reseller pricing). We use `price.product`. Future work.
- Per-tenant cap-raise migration. (Hard-cutover stance approved.)
- `trade_domain` pricing.
- All DNS / customer / tag / email / catalog tools — they're either `allow` (no pricing) or destructive `confirm` (0). Untouched.
- Refactor of `validateConfirmation` / drift handling. Unchanged.

---

*End of spec.*

# Openprovider Full API Coverage — Design Spec

- **Status:** Approved (brainstormed 2026-05-28)
- **Goal:** Expose the operational Openprovider REST API (per `PostMan/OP Rest API.postman_collection.json`) as MCP tools — ~86 new tools across 7 batches, on top of the existing 10 (domains check/list/get/register/update + contacts CRUD). Each tool inherits the platform's auth, RLS, policy engine, audit chain, and RBAC.
- **Delivery:** **One spec (this doc) → one TDD plan per batch → subagent-driven build per batch**, shipped + reviewed incrementally. Batch 1 (domain lifecycle) first.
- **Branch:** `feat/enterprise-phase-1` (stacks on the existing tool pattern).
- **Out of scope (deliberately excluded):** Financials (Invoices, Payments, Transactions), Reseller settings/statistics/service, Auth/Authorization (handled internally by the token manager), Additional-Data / Customer-Additional-Data. An AI agent should not move money or change account administration; revisit per demand.

---

## 1. Decisions (from brainstorming)

1. **Scope:** the ~86 operational endpoints (domains lifecycle, DNS, SSL, customers, email, license, catalog); skip financials/reseller-admin/auth.
2. **Delivery:** one design spec + an independent per-batch plan/build (like the phases).
3. **Write policy:** **allow low-risk writes; confirm only billable + destructive.** Reads are `allow` (viewer-ok); non-billable, non-destructive create/update run in `allow` mode (operators act directly); billable ops are `confirm` + spend-cap; deletes (and re-billing ops) are `confirm`.
4. **First batch:** domain lifecycle.

---

## 2. Conventions

**Naming:** `verb_noun` snake_case, matching the existing tools (`check_domain`, `register_domain`, `create_contact`). New examples: `renew_domain`, `transfer_domain`, `create_dns_zone`, `update_dns_record`, `delete_dns_zone`, `create_ssl_order`, `create_customer`, `create_email_template`, `create_plesk_license`, `list_tlds`.

**Per-tool wiring (each new tool):**
1. Zod input schema in `src/openprovider/types.ts` (strict; mirror the Postman request body — no silent coercion, per Phase-5 policy).
2. A method on `OpenproviderClient` (`src/openprovider/client.ts`) calling the endpoint (reusing the existing retry/circuit-breaker/error mapping).
3. A tool factory `src/tools/<name>.ts` returning a `DispatcherTool` (name, description, inputSchema, handler).
4. An entry in `buildToolCatalog()` (`src/mcp/tool-catalog.ts`) so `tools/list` advertises it, AND in the per-request `dispatchFactory` tool array (`src/server.ts`) so `tools/call` dispatches it.
5. A `DEFAULT_POLICY` mode (see §3) — added to BOTH the `signup_tenant` JSON doc (migration) and `DEFAULT_POLICY` in `src/policies/schema.ts`. **Unmapped tools default to `deny`**, so every tool needs a mode (explicit or wildcard).

**Read classification (one-time engine change, Batch 1):** `src/policies/engine.ts` `isReadTool` becomes **prefix-based** — returns true for names starting `list_`, `get_`, `check_`, `suggest_`, plus the existing explicit reads (`list_pending_confirmations`). This lets every new read tool be viewer-accessible without hand-maintaining `READ_TOOLS`. (Tested; the viewer-gate behavior is otherwise unchanged.)

**Policy wildcards:** `DEFAULT_POLICY.tools` keeps `"list_*":"allow"`, `"get_*":"allow"` and gains `"check_*":"allow"`, `"suggest_*":"allow"`. All other (write) tools get **explicit** modes (wildcarding writes is unsafe — billable vs non-billable create/update differ). So reads are wildcard-allowed; every write tool is explicitly listed.

**Confirm + spend:** billable tools price via the existing `pricing` + 5% drift guard + spend-cap reservation (like `register_domain`). Non-billable confirm tools (deletes) use confirm WITHOUT a spend reservation. Approver roles for all confirm tools = `['owner','admin']` (existing model). Operators propose; owner/admin approve.

---

## 3. Tool inventory (mode legend: **R**=allow+read · **A**=allow write · **C**=confirm · **C$**=confirm+spend/billable)

### Batch 1 — Domain lifecycle (11)
| tool | HTTP | mode |
|---|---|---|
| `suggest_domain` | POST /domains/suggest-name | R |
| `get_domain_authcode` | GET /domains/:id/authcode | R |
| `reset_domain_authcode` | POST /domains/:id/authcode/reset | A |
| `approve_domain_transfer` | POST /domains/:id/transfer/approve | A |
| `send_foa1_domain_transfer` | POST /domains/:id/transfer/send-foa1 | A |
| `delete_domain` | DELETE /domains/:id | C |
| `restart_domain_operation` | POST /domains/:id/last-operation/restart | C |
| `renew_domain` | POST /domains/:id/renew | C$ |
| `transfer_domain` | POST /domains/transfer | C$ |
| `trade_domain` | POST /domains/trade | C$ |
| `restore_domain` | POST /domains/:id/restore | C$ |

### Batch 2 — DNS (21)
| tool | HTTP | mode |
|---|---|---|
| `list_dns_zones` / `get_dns_zone` | GET /dns/zones · /dns/zones/:name | R |
| `create_dns_zone` / `update_dns_zone` | POST · PUT /dns/zones | A |
| `delete_dns_zone` | DELETE /dns/zones/:name | C |
| `list_dns_zone_records` | GET /dns/zones/:name/records | R |
| `list_nameservers` / `get_nameserver` | GET | R |
| `create_nameserver` / `update_nameserver` | POST · PUT | A |
| `delete_nameserver` | DELETE | C |
| `list_ns_groups` / `get_ns_group` | GET | R |
| `create_ns_group` / `update_ns_group` | POST · PUT | A |
| `delete_ns_group` | DELETE | C |
| `list_dns_templates` / `get_dns_template` | GET | R |
| `create_dns_template` | POST | A |
| `delete_dns_template` | DELETE | C |
| `create_domain_token` | POST /dns/domain-token | A |

(DNS-record mutation is performed via `update_dns_zone` — the OP API edits records through the zone update payload; the spec's per-batch plan documents the records-in-zone shape.)

### Batch 3 — Catalog + tags (6)
| tool | HTTP | mode |
|---|---|---|
| `list_tlds` / `get_tld` | GET /tlds · /tlds/:name | R |
| `get_domain_price` | GET /domains/prices | R |
| `list_tags` | GET /tags | R |
| `create_tag` | POST /tags | A |
| `delete_tag` | DELETE /tags/:id | C |

### Batch 4 — SSL (15)
| tool | HTTP | mode |
|---|---|---|
| `list_ssl_products` / `get_ssl_product` | GET | R |
| `list_ssl_orders` / `get_ssl_order` | GET | R |
| `get_ssl_approver_emails` | GET | R |
| `create_ssl_order` / `renew_ssl_order` / `reissue_ssl_order` | POST | C$ |
| `cancel_ssl_order` | POST /ssl/orders/:id/cancel | C |
| `update_ssl_order` | PUT | A |
| `update_ssl_approver_email` / `resend_ssl_approver_email` | PUT · POST | A |
| `create_csr` / `decode_csr` | POST | A |
| `create_ssl_otp_token` | POST | A |

### Batch 5 — Customers (6)
| tool | HTTP | mode |
|---|---|---|
| `list_customers` / `get_customer` / `get_deleted_customer` | GET | R |
| `create_customer` / `update_customer` | POST · PUT | A |
| `delete_customer` | DELETE | C |

### Batch 6 — Email & adjacents (18)
| tool | HTTP | mode |
|---|---|---|
| `list_email_templates` | GET | R |
| `create_email_template` / `update_email_template` | POST · PUT | A |
| `delete_email_template` | DELETE | C |
| `list_email_verification_domains` | GET | R |
| `start_email_verification` / `restart_email_verification` | POST | A |
| `get_dmarc` / `list_dmarc_subscriptions` | GET | R |
| `create_dmarc` / `retry_dmarc` / `dmarc_sso_login` | POST/GET | A |
| `delete_dmarc` | DELETE | C |
| `get_spam_experts_domain` | GET | R |
| `spam_experts_login_url` | POST | A |
| `create_spam_experts_domain` / `update_spam_experts_domain` | POST · PUT | A |
| `delete_spam_experts_domain` | DELETE | C |

### Batch 7 — License (9)
| tool | HTTP | mode |
|---|---|---|
| `list_license_items` / `list_license_prices` | GET | R |
| `list_plesk_licenses` / `get_plesk_license` / `get_plesk_key` | GET | R |
| `create_plesk_license` | POST | C$ |
| `update_plesk_license` / `reset_plesk_hwid` | PUT · POST | A |
| `delete_plesk_license` | DELETE | C |

**Totals:** 11 + 21 + 6 + 15 + 6 + 18 + 9 = **86 new tools** (+ the 10 existing = 96 of the collection's 108; the ~12 remaining are the excluded financials/reseller/auth/additional-data).

---

## 4. Per-batch plan structure (each batch = its own writing-plans → subagent build)

Each batch's TDD plan covers, per tool: (1) the zod schema (extracted from the Postman request body — the plan author reads the collection request for exact fields), (2) the client method + a Nock-backed unit test, (3) the tool factory, (4) catalog + dispatchFactory registration, (5) the `DEFAULT_POLICY` mode addition (a migration that `CREATE OR REPLACE`s `signup_tenant`'s policy doc + updates `schema.ts` `DEFAULT_POLICY`, with a test that a freshly provisioned tenant has the modes), (6) an integration test exercising the tool through the dispatcher with the right policy mode (allow runs; confirm → confirmation_required; viewer gate for writes). Batch 1 additionally makes the `isReadTool` prefix change + its test.

**Batch order:** 1 Domain-lifecycle → 2 DNS → 3 Catalog → 4 SSL → 5 Customers → 6 Email → 7 License. Each ships independently; the spec is the shared reference.

---

## 5. Testing & cross-cutting

- **Unit:** each client method (Nock happy + error path); each new schema (valid/invalid).
- **Integration:** each batch — a representative allow-tool runs (or returns `openprovider_not_connected` without creds), a confirm-tool returns `confirmation_required` then consumes, a billable confirm-tool reserves spend, the viewer gate blocks a non-read write tool, `tools/list` includes the batch's tools.
- **Policy migration test:** a freshly signed-up tenant's `DEFAULT_POLICY` carries every new tool's mode.
- No change to the dispatcher, confirm flow, audit, or RBAC engine beyond the `isReadTool` prefix tweak (Batch 1).

---

## 6. Risks / notes

- **Schema fidelity:** OP request bodies are large (esp. SSL order, DNS zone records, customer). Each batch plan must extract the exact fields from the Postman collection; the existing strict-zod + no-silent-coercion policy applies.
- **DNS records:** mutated via the zone update payload (no standalone record CRUD endpoints in the collection beyond "List Zone records"); the Batch-2 plan documents the records array shape on `update_dns_zone`.
- **Billable classification:** `renew/transfer/trade/restore` domain, `create/renew/reissue` SSL order, `create_plesk_license` are `C$` (priced + spend-capped). If pricing for a given tool isn't available via the existing pricing path, the plan falls back to confirm-without-spend and notes it.
- **DEFAULT_POLICY growth:** each batch adds a migration that re-issues the `signup_tenant` policy doc; existing tenants' policies are NOT retroactively updated (they can edit policy in the dashboard) — documented per batch.

---

## 7. Out of scope (restated)

Invoices / Payments / Transactions; Reseller Service / Settings / Statistics; Auth/Authorization (internal); Additional-Data / Customer-Additional-Data. SSL/email sub-flows that require external provider OAuth beyond a single call are deferred within their batch if they don't fit the one-call tool shape.

---

*End of spec.*

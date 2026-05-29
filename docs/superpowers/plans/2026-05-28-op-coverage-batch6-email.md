# OP Coverage Batch 6 — Email & Adjacents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the 18 email-adjacent Openprovider tools (Email Templates, Email Verification, EasyDmarc, Spam Experts) to the MCP, following the established tool pattern.

**Architecture:** Same per-tool pattern as prior batches. 5 reads (covered by `list_*`/`get_*` wildcards), 10 allow-writes, 3 confirm-deletes.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), zod, fetch-based client, Postgres, Vitest + Nock + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-28-openprovider-full-api-coverage-design.md` (§3 Batch 6). **Branch:** `feat/enterprise-phase-1`.

---

## Endpoint reference (exact, from Postman collection)

| tool | method | path | body / query | mode |
|---|---|---|---|---|
| `list_email_templates` | GET | `/emails` | — | R |
| `create_email_template` | POST | `/emails` | template body (group, name, fields[], locale[], tags[], is_active, is_default) | A |
| `update_email_template` | PUT | `/emails/:email_id` | same as create body + `id` | A |
| `delete_email_template` | DELETE | `/emails/:email_id` | — | C |
| `list_email_verification_domains` | GET | `/customers/verifications/emails/domains` | — | R |
| `start_email_verification` | POST | `/customers/verifications/emails/start` | `{ email, handle, language?, tag? }` | A |
| `restart_email_verification` | POST | `/customers/verifications/emails/restart` | `{ email, handle, language?, tag? }` | A |
| `get_dmarc` | GET | `/easydmarcs?domain.name=&domain.extension=` | query params (DomainRef) | R |
| `list_dmarc_subscriptions` | GET | `/easydmarcs/list` | — | R |
| `create_dmarc` | POST | `/easydmarcs` | `{ domain: { extension, name }, owner_handle }` | A |
| `retry_dmarc` | POST | `/easydmarcs/:id/retry` | `{ id }` | A |
| `dmarc_sso_login` | GET | `/easydmarcs/:id/sso` | — | A |
| `delete_dmarc` | DELETE | `/easydmarcs/:id` | — | C |
| `get_spam_experts_domain` | GET | `/spam-expert/domains/:domain_name` | — | R |
| `spam_experts_login_url` | POST | `/spam-expert/generate-login-url` | `{ bundle, domain_or_email }` | A |
| `create_spam_experts_domain` | POST | `/spam-expert/domains` | `{ aliases?: string[], bundle, destinations[], domain_name, products: { archiving, incoming, outgoing } }` | A |
| `update_spam_experts_domain` | PUT | `/spam-expert/domains/:domain_name` | similar to create BUT `aliases: { add?: string[], remove?: string[] }` (object, not array) | A |
| `delete_spam_experts_domain` | DELETE | `/spam-expert/domains/:domain_name` | — | C |

**Key structural notes from extraction:**
- All `easydmarc` ids are **numeric integers**; spam-expert domain identifiers are **string domain names**; email-template ids are **numeric integers**.
- `dmarc_sso_login` is a GET in the collection BUT its tool name (`dmarc_*`) doesn't match the read-prefix convention — so `isReadTool` returns false. Explicit policy mode `allow` lets operators call it but viewers cannot (matches spec intent: side-effecty SSO URL generation).
- `create_email_template` body in the Postman collection contains a copy-paste artefact (a response envelope). Real shape inferred: `{ group: string (required), name: string (required), fields?: [{ name, value }], locale?: string[], tags?: [{ key, value }], is_active?: boolean, is_default?: boolean, id?: number }`.
- `update_email_template` body is absent from the collection — safe assumption is same shape as create.
- `create_spam_experts_domain` uses `aliases: string[]`; `update_spam_experts_domain` uses `aliases: { add?: string[], remove?: string[] }` (structural diff like Batch-2's DNS zones).
- `retry_dmarc` body redundantly includes `id` (same as path) — client builds path from `parsed.id`, sends parsed.
- Spam-expert paths use `/spam-expert/...` (singular, hyphenated).

**Catalog count:** 70 (after Batch 5) → **88**.

**Modes to ADD to `DEFAULT_POLICY.tools` + migration 0019 (13 explicit entries; reads covered by wildcards):**
- `create_email_template`: allow
- `update_email_template`: allow
- `delete_email_template`: confirm
- `start_email_verification`: allow
- `restart_email_verification`: allow
- `create_dmarc`: allow
- `retry_dmarc`: allow
- `dmarc_sso_login`: allow
- `delete_dmarc`: confirm
- `spam_experts_login_url`: allow
- `create_spam_experts_domain`: allow
- `update_spam_experts_domain`: allow
- `delete_spam_experts_domain`: confirm

**Client contract (established):** arg-methods `(token, args)` with `.parse()`; query-string methods use `URLSearchParams`; string path params `encodeURIComponent`-encoded; numeric ids interpolated directly.

---

## Task 1: DEFAULT_POLICY modes + migration 0019

**Files:** Modify `src/policies/schema.ts`; Create `migrations/0019_email_policy.sql`; Modify `migrations/meta/_journal.json`; Test `tests/integration/db/email-policy.test.ts`.

- [ ] **Step 1: Append 13 modes** to `DEFAULT_POLICY.tools` (after Batch-5 customer entries), exactly as listed above.

- [ ] **Step 2: Failing test** `tests/integration/db/email-policy.test.ts` mirroring `customers-policy.test.ts`. Email `b6-email-policy@example.com`. Assert representative modes (one per sub-service): `create_email_template=allow`, `delete_email_template=confirm`, `start_email_verification=allow`, `create_dmarc=allow`, `dmarc_sso_login=allow`, `delete_dmarc=confirm`, `create_spam_experts_domain=allow`, `delete_spam_experts_domain=confirm`.

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Create `migrations/0019_email_policy.sql`** by copying `migrations/0018_customers_policy.sql` VERBATIM, appending 13 new keys to the `tools` JSON:
```
,"create_email_template":"allow","update_email_template":"allow","delete_email_template":"confirm","start_email_verification":"allow","restart_email_verification":"allow","create_dmarc":"allow","retry_dmarc":"allow","dmarc_sso_login":"allow","delete_dmarc":"confirm","spam_experts_login_url":"allow","create_spam_experts_domain":"allow","update_spam_experts_domain":"allow","delete_spam_experts_domain":"confirm"
```
Journal entry idx 18, tag `0019_email_policy`.

- [ ] **Step 5: Run → pass.** Typecheck.
- [ ] **Step 6: Commit** `git commit -m "feat(op-batch6): default-policy modes for email tools (migration 0019)"`.

---

## Task 2: zod schemas (15 new exports + helpers)

**Files:** Modify `src/openprovider/types.ts`; Test `src/openprovider/types.test.ts` (append).

The 5 read tools take `NoArgs` (reused). Path-arg readers (`get_spam_experts_domain`) use `SpamExpertsDomainArg`. `get_dmarc` uses `DomainRef` directly (existing) wrapped in `GetDmarcArgs = z.object({ domain: DomainRef })`. New schemas:

```ts
// path-arg
export const EmailTemplateIdArg = z.object({ id: z.number().int().positive() });
export const EasyDmarcIdArg = z.object({ id: z.number().int().positive() });
export const SpamExpertsDomainArg = z.object({ domain_name: z.string().min(1) });

// query-arg (dmarc list-by-domain)
export const GetDmarcArgs = z.object({ domain: DomainRef });

// email templates
const EmailTemplateField = z.object({ name: z.string(), value: z.string() });
const EmailTemplateTag = z.object({ key: z.string(), value: z.string() });
const EmailTemplateBody = z.object({
  group: z.string().min(1),
  name: z.string().min(1),
  id: z.number().int().nonnegative().optional(),
  fields: z.array(EmailTemplateField).optional(),
  locale: z.array(z.string()).optional(),
  tags: z.array(EmailTemplateTag).optional(),
  is_active: z.boolean().optional(),
  is_default: z.boolean().optional(),
});
export const CreateEmailTemplateArgs = EmailTemplateBody;
export const UpdateEmailTemplateArgs = EmailTemplateBody.extend({ id: z.number().int().positive() });

// email verification
const EmailVerificationBody = z.object({
  email: z.string().min(1),
  handle: z.string().min(1),
  language: z.string().optional(),
  tag: z.string().optional(),
});
export const StartEmailVerificationArgs = EmailVerificationBody;
export const RestartEmailVerificationArgs = EmailVerificationBody;

// dmarc
export const CreateDmarcArgs = z.object({
  domain: DomainRef,
  owner_handle: z.string().min(1),
});
export const RetryDmarcArgs = z.object({ id: z.number().int().positive() });
export const DmarcSsoLoginArgs = z.object({ id: z.number().int().positive() });

// spam experts
const SpamExpertsDestination = z.object({
  hostname: z.string().min(1),
  port: z.number().int().positive(),
});
const SpamExpertsProducts = z.object({
  archiving: z.boolean(),
  incoming: z.boolean(),
  outgoing: z.boolean(),
});
export const SpamExpertsLoginUrlArgs = z.object({
  bundle: z.boolean(),
  domain_or_email: z.string().min(1),
});
export const CreateSpamExpertsDomainArgs = z.object({
  aliases: z.array(z.string()).optional(),
  bundle: z.boolean(),
  destinations: z.array(SpamExpertsDestination).min(1),
  domain_name: z.string().min(1),
  products: SpamExpertsProducts,
});
export const UpdateSpamExpertsDomainArgs = z.object({
  domain_name: z.string().min(1),
  bundle: z.boolean(),
  destinations: z.array(SpamExpertsDestination).min(1),
  products: SpamExpertsProducts,
  aliases: z.object({
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  }).optional(),
});
```
Helpers `EmailTemplateField`, `EmailTemplateTag`, `EmailTemplateBody`, `EmailVerificationBody`, `SpamExpertsDestination`, `SpamExpertsProducts` are non-exported (file-private). 15 exported schemas: `EmailTemplateIdArg`, `EasyDmarcIdArg`, `SpamExpertsDomainArg`, `GetDmarcArgs`, `CreateEmailTemplateArgs`, `UpdateEmailTemplateArgs`, `StartEmailVerificationArgs`, `RestartEmailVerificationArgs`, `CreateDmarcArgs`, `RetryDmarcArgs`, `DmarcSsoLoginArgs`, `SpamExpertsLoginUrlArgs`, `CreateSpamExpertsDomainArgs`, `UpdateSpamExpertsDomainArgs`. Plus `export type Xxx = z.infer<typeof Xxx>` for each.

- [ ] **Step 1: Failing tests** for each schema (positive + negative). Confirm the structural diff: `CreateSpamExpertsDomainArgs.aliases` is `string[]`, `UpdateSpamExpertsDomainArgs.aliases` is `{ add?, remove? }`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Add schemas + type exports.**
- [ ] **Step 4: Run → pass.** Typecheck.
- [ ] **Step 5: Commit** `git commit -m "feat(op-batch6): zod schemas for email tools"`.

---

## Task 3: `OpenproviderClient` methods (18) + Nock tests + mock cascade

**Files:** Modify `src/openprovider/client.ts` (+ interface); Test `src/openprovider/client.test.ts`; cascade fixes in `pricing.test.ts`, `check-domain.test.ts`, `read-tools.test.ts`, `write-tools.test.ts`.

The 18 methods:
```ts
// Email templates
listEmailTemplates(token)                                       // GET /emails
createEmailTemplate(token, args: CreateEmailTemplateArgs)       // POST /emails, body=parsed
updateEmailTemplate(token, args: UpdateEmailTemplateArgs)       // PUT /emails/${parsed.id}, body=parsed
deleteEmailTemplate(token, id: number)                          // DELETE /emails/${id}

// Email verification
listEmailVerificationDomains(token)                             // GET /customers/verifications/emails/domains
startEmailVerification(token, args: StartEmailVerificationArgs) // POST /customers/verifications/emails/start
restartEmailVerification(token, args: RestartEmailVerificationArgs) // POST /customers/verifications/emails/restart

// EasyDmarc
getDmarc(token, args: GetDmarcArgs)                             // GET /easydmarcs?domain.name=...&domain.extension=...
listDmarcSubscriptions(token)                                   // GET /easydmarcs/list
createDmarc(token, args: CreateDmarcArgs)                       // POST /easydmarcs
retryDmarc(token, args: RetryDmarcArgs)                         // POST /easydmarcs/${parsed.id}/retry, body=parsed
dmarcSsoLogin(token, args: DmarcSsoLoginArgs)                   // GET /easydmarcs/${parsed.id}/sso
deleteDmarc(token, id: number)                                  // DELETE /easydmarcs/${id}

// Spam Experts
getSpamExpertsDomain(token, domainName: string)                 // GET /spam-expert/domains/${encodeURIComponent(domainName)}
spamExpertsLoginUrl(token, args: SpamExpertsLoginUrlArgs)       // POST /spam-expert/generate-login-url
createSpamExpertsDomain(token, args: CreateSpamExpertsDomainArgs) // POST /spam-expert/domains
updateSpamExpertsDomain(token, args: UpdateSpamExpertsDomainArgs) // PUT /spam-expert/domains/${encodeURIComponent(parsed.domain_name)}, body=parsed
deleteSpamExpertsDomain(token, domainName: string)              // DELETE /spam-expert/domains/${encodeURIComponent(domainName)}
```
All unwrap `(b as { data?: unknown }).data ?? b`. All 13 arg-methods call `.parse()`.

For `getDmarc`, build query via URLSearchParams with dot-notation keys (same pattern as Batch-3 `getDomainPrice`):
```ts
const params = new URLSearchParams();
params.append('domain.name', parsed.domain.name);
params.append('domain.extension', parsed.domain.extension);
```

- [ ] **Step 1: Failing Nock tests** for all 18 (body matchers on writes; `.query({...})` for `getDmarc`; numeric ids interpolated directly).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the 18 methods + interface signatures. Import the 13 new arg types from `./types.js`.
- [ ] **Step 4: Run + fix mock cascade.** Add `vi.fn()` stubs for all 18 to the 4 mock-client files. Re-run typecheck (0) + `npx vitest run` (full unit green).
- [ ] **Step 5: Commit** including cascade fixes: `git commit -m "feat(op-batch6): OpenproviderClient email methods"`.

---

## Task 4: Tool factories (18) + catalog + dispatch

**Files:** Create 18 factories; Modify `tool-catalog.ts`, `server.ts`, `tool-catalog.test.ts`.

| tool name | factory | schema | client call | description |
|---|---|---|---|---|
| `list_email_templates` | `createListEmailTemplatesTool` | `NoArgs` | `listEmailTemplates(token)` | "List email templates." |
| `create_email_template` | `createCreateEmailTemplateTool` | `CreateEmailTemplateArgs` | `createEmailTemplate(token, parsed)` | "Create an email template." |
| `update_email_template` | `createUpdateEmailTemplateTool` | `UpdateEmailTemplateArgs` | `updateEmailTemplate(token, parsed)` | "Update an email template." |
| `delete_email_template` | `createDeleteEmailTemplateTool` | `EmailTemplateIdArg` | `deleteEmailTemplate(token, parsed.id)` | "Delete an email template (requires approval)." |
| `list_email_verification_domains` | `createListEmailVerificationDomainsTool` | `NoArgs` | `listEmailVerificationDomains(token)` | "List domains usable for customer email verification." |
| `start_email_verification` | `createStartEmailVerificationTool` | `StartEmailVerificationArgs` | `startEmailVerification(token, parsed)` | "Start an email verification flow for a customer." |
| `restart_email_verification` | `createRestartEmailVerificationTool` | `RestartEmailVerificationArgs` | `restartEmailVerification(token, parsed)` | "Restart an email verification flow." |
| `get_dmarc` | `createGetDmarcTool` | `GetDmarcArgs` | `getDmarc(token, parsed)` | "Get the EasyDmarc subscription for a domain." |
| `list_dmarc_subscriptions` | `createListDmarcSubscriptionsTool` | `NoArgs` | `listDmarcSubscriptions(token)` | "List EasyDmarc subscriptions." |
| `create_dmarc` | `createCreateDmarcTool` | `CreateDmarcArgs` | `createDmarc(token, parsed)` | "Create an EasyDmarc subscription for a domain." |
| `retry_dmarc` | `createRetryDmarcTool` | `RetryDmarcArgs` | `retryDmarc(token, parsed)` | "Retry an EasyDmarc subscription." |
| `dmarc_sso_login` | `createDmarcSsoLoginTool` | `DmarcSsoLoginArgs` | `dmarcSsoLogin(token, parsed)` | "Get the EasyDmarc SSO login URL." |
| `delete_dmarc` | `createDeleteDmarcTool` | `EasyDmarcIdArg` | `deleteDmarc(token, parsed.id)` | "Delete an EasyDmarc subscription (requires approval)." |
| `get_spam_experts_domain` | `createGetSpamExpertsDomainTool` | `SpamExpertsDomainArg` | `getSpamExpertsDomain(token, parsed.domain_name)` | "Get a SpamExperts domain configuration." |
| `spam_experts_login_url` | `createSpamExpertsLoginUrlTool` | `SpamExpertsLoginUrlArgs` | `spamExpertsLoginUrl(token, parsed)` | "Generate a SpamExperts dashboard login URL." |
| `create_spam_experts_domain` | `createCreateSpamExpertsDomainTool` | `CreateSpamExpertsDomainArgs` | `createSpamExpertsDomain(token, parsed)` | "Provision a SpamExperts domain." |
| `update_spam_experts_domain` | `createUpdateSpamExpertsDomainTool` | `UpdateSpamExpertsDomainArgs` | `updateSpamExpertsDomain(token, parsed)` | "Update a SpamExperts domain." |
| `delete_spam_experts_domain` | `createDeleteSpamExpertsDomainTool` | `SpamExpertsDomainArg` | `deleteSpamExpertsDomain(token, parsed.domain_name)` | "Delete a SpamExperts domain (requires approval)." |

NO confirm logic in factories.

- [ ] **Step 1: Create the 18 factory files** (~20 lines each, mirror Batch-5 exemplars).
- [ ] **Step 2: Register** all 18 in `buildToolCatalog` (stub deps) and `dispatchFactory` (real deps).
- [ ] **Step 3: Update catalog test:** 18 names; count 70 → 88.
- [ ] **Step 4: Verify** typecheck (0); catalog test green; full unit green.
- [ ] **Step 5: Commit** all 21 files: `git commit -m "feat(op-batch6): email tools (templates/verification/dmarc/spam-experts)"`.

---

## Task 5: Integration test + full gate + commit

**Files:** Create `tests/integration/mcp/email-e2e.test.ts`.

Model on `tests/integration/mcp/customers-e2e.test.ts`. No OP creds. Assert:

1. **tools/list includes all 18 new names.**
2. **Allow read reaches handler:** operator → `list_email_templates {}` → `openprovider_not_connected`; operator → `get_dmarc { domain: { name:'x', extension:'com' } }` → `openprovider_not_connected`.
3. **Allow write reaches handler:** operator → `create_email_template { group:'ive', name:'tpl' }` → `openprovider_not_connected`; operator → `dmarc_sso_login { id: 1 }` → `openprovider_not_connected`.
4. **Confirm short-circuits:** operator → `delete_email_template { id: 1 }` → proposal shape; operator → `delete_dmarc { id: 1 }` → proposal shape; operator → `delete_spam_experts_domain { domain_name: 'x.com' }` → proposal shape (NOT executed).
5. **Viewer gate:** viewer → `delete_email_template` → `policy_denied`; viewer → `create_email_template` → `policy_denied`; viewer → `dmarc_sso_login` → `policy_denied` (despite being a GET endpoint, the tool name lacks a read prefix so isReadTool returns false); viewer → `list_email_templates {}` (read) → `openprovider_not_connected`.

- [ ] **Step 1: Write the test** using the established harness from `customers-e2e.test.ts`.
- [ ] **Step 2: Run → pass.**
- [ ] **Step 3: FULL gate** — typecheck (0), lint (0), unit green, integration green (live skips OK; `audit-chain` may flake under parallel load — re-run in isolation to confirm pre-existing). Catalog test = 88.
- [ ] **Step 4: Commit + STOP** (do NOT push): `git add tests/integration/mcp/email-e2e.test.ts && git commit -m "test(op-batch6): email dispatch + policy integration"`.

---

## Self-Review

**Spec coverage:** All 18 tools (5 reads, 10 allow-writes, 3 confirm-deletes) → Task 4; policy → Task 1; schemas → Task 2; client → Task 3; integration → Task 5. ✅

**Type consistency:** Schema names match across tasks; client method names match factories; catalog grows 70 → 88. ✅

**Notable decisions:**
- `dmarc_sso_login` is treated as `allow`-mode (operator-only) despite being a GET endpoint, since its name doesn't match the read-prefix convention. Side-effecty (issues SSO URL).
- Spam-experts `aliases` shape differs between create (`string[]`) and update (`{ add?, remove? }`) — schemas enforce this distinction.
- `create_email_template` body is constructed from inferred shape due to a Postman copy-paste artefact in the collection. Forgiving schema (most fields optional). Verification against the live API may be needed later.

*End of plan.*

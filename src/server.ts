import 'dotenv/config';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/transport.js';
import { startOtel } from './observability/otel.js';
import { createLogger } from './observability/logger.js';
import { createDb } from './db/client.js';
import { createGcpKms } from './secrets/gcp-kms.js';
import { createApiKeyResolver } from './auth/api-key.js';
import type { Principal } from './auth/principal.js';
import { createDispatcher, type ConfirmDeps, type DispatcherTool } from './mcp/dispatch.js';
import { signup as signupFn, findUserByEmail } from './auth/local-auth.js';
import { hashPassword, verifyPassword, assertPasswordPolicy } from './auth/password.js';
import { registerDashboard } from './dashboard/server.js';
import { registerAuthRoutes } from './dashboard/routes/auth.js';
import { registerOverview } from './dashboard/routes/overview.js';
import { registerOpenprovider } from './dashboard/routes/openprovider.js';
import { registerPolicy } from './dashboard/routes/policy.js';
import { registerKeys } from './dashboard/routes/keys.js';
import { registerAudit } from './dashboard/routes/audit.js';
import { registerConfirmations } from './dashboard/routes/confirmations.js';
import { registerUsers } from './dashboard/routes/users.js';
import { registerAccept } from './dashboard/routes/accept.js';
import { createPgAuditSink } from './audit/pg-sink.js';
import { createCheckDomainTool } from './tools/check-domain.js';
import { createListDomainsTool } from './tools/list-domains.js';
import { createGetDomainTool } from './tools/get-domain.js';
import { createListContactsTool } from './tools/list-contacts.js';
import { createGetContactTool } from './tools/get-contact.js';
import { createListPendingConfirmationsTool } from './tools/list-pending-confirmations.js';
import { createConfirmPendingTool } from './tools/confirm-pending.js';
import { createRegisterDomainTool } from './tools/register-domain.js';
import { createUpdateDomainTool } from './tools/update-domain.js';
import { createCreateContactTool } from './tools/create-contact.js';
import { createUpdateContactTool } from './tools/update-contact.js';
import { createDeleteContactTool } from './tools/delete-contact.js';
import { createSuggestDomainTool } from './tools/suggest-domain.js';
import { createGetDomainAuthcodeTool } from './tools/get-domain-authcode.js';
import { createResetDomainAuthcodeTool } from './tools/reset-domain-authcode.js';
import { createApproveDomainTransferTool } from './tools/approve-domain-transfer.js';
import { createSendFoa1DomainTransferTool } from './tools/send-foa1-domain-transfer.js';
import { createDeleteDomainTool } from './tools/delete-domain.js';
import { createRestartDomainOperationTool } from './tools/restart-domain-operation.js';
import { createRenewDomainTool } from './tools/renew-domain.js';
import { createTransferDomainTool } from './tools/transfer-domain.js';
import { createTradeDomainTool } from './tools/trade-domain.js';
import { createRestoreDomainTool } from './tools/restore-domain.js';
import { createListDnsZonesTool } from './tools/list-dns-zones.js';
import { createGetDnsZoneTool } from './tools/get-dns-zone.js';
import { createListDnsZoneRecordsTool } from './tools/list-dns-zone-records.js';
import { createListNameserversTool } from './tools/list-nameservers.js';
import { createGetNameserverTool } from './tools/get-nameserver.js';
import { createListNsGroupsTool } from './tools/list-ns-groups.js';
import { createGetNsGroupTool } from './tools/get-ns-group.js';
import { createListDnsTemplatesTool } from './tools/list-dns-templates.js';
import { createGetDnsTemplateTool } from './tools/get-dns-template.js';
import { createCreateDnsZoneTool } from './tools/create-dns-zone.js';
import { createUpdateDnsZoneTool } from './tools/update-dns-zone.js';
import { createCreateNameserverTool } from './tools/create-nameserver.js';
import { createUpdateNameserverTool } from './tools/update-nameserver.js';
import { createCreateNsGroupTool } from './tools/create-ns-group.js';
import { createUpdateNsGroupTool } from './tools/update-ns-group.js';
import { createCreateDnsTemplateTool } from './tools/create-dns-template.js';
import { createCreateDomainTokenTool } from './tools/create-domain-token.js';
import { createDeleteDnsZoneTool } from './tools/delete-dns-zone.js';
import { createDeleteNameserverTool } from './tools/delete-nameserver.js';
import { createDeleteNsGroupTool } from './tools/delete-ns-group.js';
import { createDeleteDnsTemplateTool } from './tools/delete-dns-template.js';
import { createListTldsTool } from './tools/list-tlds.js';
import { createGetTldTool } from './tools/get-tld.js';
import { createGetDomainPriceTool } from './tools/get-domain-price.js';
import { createListTagsTool } from './tools/list-tags.js';
import { createCreateTagTool } from './tools/create-tag.js';
import { createDeleteTagTool } from './tools/delete-tag.js';
import { createListSslProductsTool } from './tools/list-ssl-products.js';
import { createGetSslProductTool } from './tools/get-ssl-product.js';
import { createListSslOrdersTool } from './tools/list-ssl-orders.js';
import { createGetSslOrderTool } from './tools/get-ssl-order.js';
import { createGetSslApproverEmailsTool } from './tools/get-ssl-approver-emails.js';
import { createUpdateSslOrderTool } from './tools/update-ssl-order.js';
import { createUpdateSslApproverEmailTool } from './tools/update-ssl-approver-email.js';
import { createResendSslApproverEmailTool } from './tools/resend-ssl-approver-email.js';
import { createCreateCsrTool } from './tools/create-csr.js';
import { createDecodeCsrTool } from './tools/decode-csr.js';
import { createCreateSslOtpTokenTool } from './tools/create-ssl-otp-token.js';
import { createCreateSslOrderTool } from './tools/create-ssl-order.js';
import { createRenewSslOrderTool } from './tools/renew-ssl-order.js';
import { createReissueSslOrderTool } from './tools/reissue-ssl-order.js';
import { createCancelSslOrderTool } from './tools/cancel-ssl-order.js';
import { createListCustomersTool } from './tools/list-customers.js';
import { createGetCustomerTool } from './tools/get-customer.js';
import { createCreateCustomerTool } from './tools/create-customer.js';
import { createUpdateCustomerTool } from './tools/update-customer.js';
import { createDeleteCustomerTool } from './tools/delete-customer.js';
import { createListEmailTemplatesTool } from './tools/list-email-templates.js';
import { createCreateEmailTemplateTool } from './tools/create-email-template.js';
import { createUpdateEmailTemplateTool } from './tools/update-email-template.js';
import { createDeleteEmailTemplateTool } from './tools/delete-email-template.js';
import { createListEmailVerificationDomainsTool } from './tools/list-email-verification-domains.js';
import { createStartEmailVerificationTool } from './tools/start-email-verification.js';
import { createRestartEmailVerificationTool } from './tools/restart-email-verification.js';
import { createGetDmarcTool } from './tools/get-dmarc.js';
import { createListDmarcSubscriptionsTool } from './tools/list-dmarc-subscriptions.js';
import { createCreateDmarcTool } from './tools/create-dmarc.js';
import { createRetryDmarcTool } from './tools/retry-dmarc.js';
import { createDmarcSsoLoginTool } from './tools/dmarc-sso-login.js';
import { createDeleteDmarcTool } from './tools/delete-dmarc.js';
import { createGetSpamExpertsDomainTool } from './tools/get-spam-experts-domain.js';
import { createSpamExpertsLoginUrlTool } from './tools/spam-experts-login-url.js';
import { createCreateSpamExpertsDomainTool } from './tools/create-spam-experts-domain.js';
import { createUpdateSpamExpertsDomainTool } from './tools/update-spam-experts-domain.js';
import { createDeleteSpamExpertsDomainTool } from './tools/delete-spam-experts-domain.js';
import { createListLicensePricesTool } from './tools/list-license-prices.js';
import { createListLicenseItemsTool } from './tools/list-license-items.js';
import { createListPleskLicensesTool } from './tools/list-plesk-licenses.js';
import { createGetPleskLicenseTool } from './tools/get-plesk-license.js';
import { createGetPleskKeyTool } from './tools/get-plesk-key.js';
import { createCreatePleskLicenseTool } from './tools/create-plesk-license.js';
import { createUpdatePleskLicenseTool } from './tools/update-plesk-license.js';
import { createResetPleskHwidTool } from './tools/reset-plesk-hwid.js';
import { createDeletePleskLicenseTool } from './tools/delete-plesk-license.js';
import {
  claimConfirmation,
  unclaimConfirmation,
  withIdempotency,
  idempotencyKeyFor,
} from './policies/idempotency.js';
import { createConfirmPendingConsume } from './mcp/confirm-pending.js';
import { buildToolCatalog } from './mcp/tool-catalog.js';
import { createOpenproviderClient } from './openprovider/client.js';
import { createOpenproviderTokenManager } from './openprovider/token-manager.js';
import { createPgTokenCache } from './openprovider/token-cache-pg.js';
import { createSecretsStore } from './secrets/store.js';
import { createDbSecretsRepo } from './secrets/db-repo.js';
import { OpenproviderAccountNotConnected } from './openprovider/errors.js';
import {
  getPolicy,
  liveSpendCents,
  proposeConfirmation,
  loadConfirmation,
  settleConfirmation,
  canonicalArgsHash,
} from './policies/repo.js';
import { evaluate, resolveToolMode } from './policies/engine.js';
import { requiredApproverRoles, type Role } from './policies/schema.js';
import { createPricing, DRIFT_TOLERANCE } from './policies/pricing.js';
import { centsToEur } from './policies/money.js';
import type { LoadedConfirmation } from './policies/repo.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel });
  const otel = startOtel({
    serviceName: 'openprovider-mcp',
    ...(cfg.otlpEndpoint ? { exporterUrl: cfg.otlpEndpoint } : {}),
  });

  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const kms = createGcpKms({ keyName: cfg.gcpKmsKeyName });

  const devPrincipal: Principal = {
    kind: 'user',
    tenantId: '00000000-0000-0000-0000-000000000001',
    userId: '00000000-0000-0000-0000-000000000002',
    subject: 'dev',
    scopes: ['mcp:read'],
    role: 'owner',
  };

  // Shared Openprovider HTTP client (stateless — safe to share across requests).
  const openproviderClient = createOpenproviderClient();

  /**
   * Per-request factory. Acquires one pg pool client, sets tenant role + GUC,
   * and constructs the dispatcher with all deps bound to that connection.
   * The connection is committed/released in cleanup().
   */
  async function dispatchFactory(principal: Principal) {
    const client = await pool.connect();
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      await client.query('SET LOCAL ROLE app_role');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant',
        principal.tenantId,
      ]);

      // Resolve per-tenant Openprovider credentials lazily from the secrets store.
      const fetchCredentials = async (
        tenantId: string,
      ): Promise<{ username: string; password: string }> => {
        const u = await client.query<{ username: string }>(
          'SELECT username FROM openprovider_accounts WHERE tenant_id = $1',
          [tenantId],
        );
        const username = u.rows[0]?.username;
        if (!username) throw new OpenproviderAccountNotConnected();
        const store = createSecretsStore({
          kms,
          kmsKeyArn: cfg.gcpKmsKeyName,
          repo: createDbSecretsRepo(client),
        });
        const passwordBuf = await store.get(tenantId, 'openprovider.password');
        if (!passwordBuf) throw new OpenproviderAccountNotConnected();
        return { username, password: passwordBuf.toString('utf8') };
      };

      const tokenManager = createOpenproviderTokenManager({
        fetchCredentials,
        cache: createPgTokenCache({
          client,
          getDek: async (tenantId: string) => {
            // Read the wrapped DEK directly from tenant_keys and decrypt via KMS.
            const r = await client.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
              'SELECT wrapped_dek, kms_key_arn FROM tenant_keys WHERE tenant_id = $1',
              [tenantId],
            );
            if (!r.rows[0]) throw new Error(`no tenant_keys row for ${tenantId}`);
            return kms.decrypt(r.rows[0].kms_key_arn, r.rows[0].wrapped_dek);
          },
        }),
      });

      // Safe token retrieval — non-billable tools price at 0 without needing a real token.
      // If no Openprovider account is connected, return '' and let pricing.price() return 0
      // (which it will for non-billable tools). For billable tools the upstream call will
      // surface openprovider_not_connected naturally.
      const tokenManagerSafeToken = async (tenantId: string): Promise<string> => {
        try {
          return await tokenManager.getToken(tenantId);
        } catch (err) {
          if (err instanceof OpenproviderAccountNotConnected) return '';
          throw err;
        }
      };

      const pricing = createPricing({ client: openproviderClient });
      const CONFIRM_TTL_MS = 5 * 60 * 1000;

      const tldsOf = (toolName: string, args: unknown): string[] => {
        if (toolName !== 'register_domain' && toolName !== 'update_domain') return [];
        const a = args as { domain?: { extension: string }; domains?: { extension: string }[] };
        if (a.domain) return [a.domain.extension];
        if (a.domains) return a.domains.map((d) => d.extension);
        return [];
      };

      // Shared validation helper — used by both Path 1 (dispatcher consume) and
      // Path 2 (confirm_pending's consume). Returns the loaded confirmation on ok,
      // or an error object so both paths stay in sync.
      const validateConfirmation = async (
        token: string,
        args: unknown,
        p: Principal,
      ): Promise<{ kind: 'error'; code: string } | { kind: 'ok'; conf: LoadedConfirmation }> => {
        const conf = await loadConfirmation(client, token);
        if (!conf) return { kind: 'error', code: 'confirmation_not_found' };
        if (conf.consumedAt) return { kind: 'error', code: 'confirmation_not_found' };
        if (conf.expiresAt.getTime() <= Date.now()) {
          return { kind: 'error', code: 'confirmation_expired' };
        }
        if (!canonicalArgsHash(args, p.tenantId).equals(conf.argsHash)) {
          return { kind: 'error', code: 'validation_failed' };
        }
        const callerRole: Role | '' = p.kind === 'user' ? p.role : '';
        if (!conf.requiredApproverRoles.includes(callerRole as Role)) {
          return { kind: 'error', code: 'approver_role_required' };
        }
        // Re-price using the stored tool name (not a caller-supplied name) + drift guard.
        const freshToken = await tokenManagerSafeToken(p.tenantId);
        const fresh = freshToken ? await pricing.price(conf.toolName, args, freshToken) : 0;
        if (fresh > Math.round(conf.estimatedCostCents * (1 + DRIFT_TOLERANCE))) {
          await settleConfirmation(client, conf.id, 'released');
          return { kind: 'error', code: 'price_changed' };
        }
        return { kind: 'ok', conf };
      };

      // Path 1: ConfirmDeps for the dispatcher (same-principal re-call with a token).
      // Meta-tools that are always allowed regardless of tenant policy.
      const META_TOOLS = new Set(['confirm_pending', 'list_pending_confirmations']);

      const confirm: ConfirmDeps = {
        resolveMode: async (toolName) => {
          // Meta-tools bypass the policy gate — they are control-plane operations,
          // not billable domain actions, and should never be denied by the policy engine.
          if (META_TOOLS.has(toolName)) return 'allow';
          const policy = await getPolicy(client, principal.tenantId);
          const callerRole: Role =
            principal.kind === 'user'
              ? principal.role
              : principal.scopes.includes('mcp:write')
                ? 'operator'
                : 'viewer';
          return resolveToolMode(policy, toolName, callerRole);
        },

        propose: async ({ toolName, args, principal: p }) => {
          // Serialize on the policy row to prevent concurrent overshoot.
          await client.query('SELECT 1 FROM policies WHERE tenant_id = $1 FOR UPDATE', [
            p.tenantId,
          ]);
          const policy = await getPolicy(client, p.tenantId);
          const live = await liveSpendCents(client, p.tenantId);
          const opToken = await tokenManagerSafeToken(p.tenantId);
          const estimatedCostCents = opToken ? await pricing.price(toolName, args, opToken) : 0;
          const callerRole: Role =
            p.kind === 'user' ? p.role : p.scopes.includes('mcp:write') ? 'operator' : 'viewer';
          const decision = evaluate({
            toolName,
            args,
            role: callerRole,
            policy,
            liveSpendCents: live,
            estimatedCostCents,
            tldsInArgs: tldsOf(toolName, args),
          });
          if (decision.decision === 'deny') {
            return { kind: 'denied', reason: decision.reason };
          }
          if (decision.decision === 'allow') {
            // allow-mode tools shouldn't reach propose; treat as misconfiguration.
            return { kind: 'denied', reason: 'not_confirm_mode' };
          }
          // decision === 'requires_confirmation'
          const approvers = requiredApproverRoles(policy, toolName);
          const rec = await proposeConfirmation({
            client,
            tenantId: p.tenantId,
            principalSubject: p.subject,
            toolName,
            args,
            summaryText: `${toolName} (est. €${centsToEur(estimatedCostCents)})`,
            estimatedCostCents,
            requiredApproverRoles: approvers,
            ttlMs: CONFIRM_TTL_MS,
          });
          return {
            kind: 'proposed',
            result: {
              confirmationId: rec.id,
              confirmationToken: rec.id, // token == id in Phase 4 (RLS-scoped, single-use)
              summary: rec.summaryText,
              estimatedCostEur: centsToEur(rec.estimatedCostCents),
              requiredApproverRoles: rec.requiredApproverRoles,
              expiresAt: rec.expiresAt.toISOString(),
            },
          };
        },

        // Path 1 consume: validates, atomically claims, returns confirmationId for dispatcher to settle.
        consume: async ({ token, args, principal: p }) => {
          const validated = await validateConfirmation(token, args, p);
          if (validated.kind === 'error') return validated;
          const won = await claimConfirmation(client, validated.conf.id);
          if (!won) return { kind: 'error', code: 'confirmation_not_found' };
          return { kind: 'ok', confirmationId: validated.conf.id };
        },

        settle: async (confirmationId, outcome) => {
          if (outcome === 'released') await unclaimConfirmation(client, confirmationId);
          await settleConfirmation(client, confirmationId, outcome);
        },
      };

      // Build the base tools array first (Phase-3 tools + write tools + list_pending_confirmations).
      // confirm_pending is pushed in a second step so its consume closure can reference
      // the now-populated tools array without a forward-reference problem.

      // create_contact (allow-mode) is wrapped with withIdempotency for dedup.
      // Confirm-mode write tools do NOT get withIdempotency — the claim is the correctness guarantee.
      const createContactTool = createCreateContactTool({
        client: openproviderClient,
        tokenManager,
      });
      const wrappedCreateContact: DispatcherTool = {
        ...createContactTool,
        handler: async (args: unknown, p: Principal): Promise<unknown> => {
          const key = idempotencyKeyFor('create_contact', args, p.tenantId);
          const { result } = await withIdempotency(client, p.tenantId, key, 'create_contact', () =>
            createContactTool.handler(args, p),
          );
          return result;
        },
      };

      const tools: DispatcherTool[] = [
        createCheckDomainTool({ client: openproviderClient, tokenManager }),
        createListDomainsTool({ client: openproviderClient, tokenManager }),
        createGetDomainTool({ client: openproviderClient, tokenManager }),
        createListContactsTool({ client: openproviderClient, tokenManager }),
        createGetContactTool({ client: openproviderClient, tokenManager }),
        createRegisterDomainTool({ client: openproviderClient, tokenManager }),
        createUpdateDomainTool({ client: openproviderClient, tokenManager }),
        wrappedCreateContact,
        createUpdateContactTool({ client: openproviderClient, tokenManager }),
        createDeleteContactTool({ client: openproviderClient, tokenManager }),
        createListPendingConfirmationsTool({ getClient: () => client }),
        createSuggestDomainTool({ client: openproviderClient, tokenManager }),
        createGetDomainAuthcodeTool({ client: openproviderClient, tokenManager }),
        createResetDomainAuthcodeTool({ client: openproviderClient, tokenManager }),
        createApproveDomainTransferTool({ client: openproviderClient, tokenManager }),
        createSendFoa1DomainTransferTool({ client: openproviderClient, tokenManager }),
        createDeleteDomainTool({ client: openproviderClient, tokenManager }),
        createRestartDomainOperationTool({ client: openproviderClient, tokenManager }),
        createRenewDomainTool({ client: openproviderClient, tokenManager }),
        createTransferDomainTool({ client: openproviderClient, tokenManager }),
        createTradeDomainTool({ client: openproviderClient, tokenManager }),
        createRestoreDomainTool({ client: openproviderClient, tokenManager }),
        createListDnsZonesTool({ client: openproviderClient, tokenManager }),
        createGetDnsZoneTool({ client: openproviderClient, tokenManager }),
        createListDnsZoneRecordsTool({ client: openproviderClient, tokenManager }),
        createListNameserversTool({ client: openproviderClient, tokenManager }),
        createGetNameserverTool({ client: openproviderClient, tokenManager }),
        createListNsGroupsTool({ client: openproviderClient, tokenManager }),
        createGetNsGroupTool({ client: openproviderClient, tokenManager }),
        createListDnsTemplatesTool({ client: openproviderClient, tokenManager }),
        createGetDnsTemplateTool({ client: openproviderClient, tokenManager }),
        createCreateDnsZoneTool({ client: openproviderClient, tokenManager }),
        createUpdateDnsZoneTool({ client: openproviderClient, tokenManager }),
        createCreateNameserverTool({ client: openproviderClient, tokenManager }),
        createUpdateNameserverTool({ client: openproviderClient, tokenManager }),
        createCreateNsGroupTool({ client: openproviderClient, tokenManager }),
        createUpdateNsGroupTool({ client: openproviderClient, tokenManager }),
        createCreateDnsTemplateTool({ client: openproviderClient, tokenManager }),
        createCreateDomainTokenTool({ client: openproviderClient, tokenManager }),
        createDeleteDnsZoneTool({ client: openproviderClient, tokenManager }),
        createDeleteNameserverTool({ client: openproviderClient, tokenManager }),
        createDeleteNsGroupTool({ client: openproviderClient, tokenManager }),
        createDeleteDnsTemplateTool({ client: openproviderClient, tokenManager }),
        createListTldsTool({ client: openproviderClient, tokenManager }),
        createGetTldTool({ client: openproviderClient, tokenManager }),
        createGetDomainPriceTool({ client: openproviderClient, tokenManager }),
        createListTagsTool({ client: openproviderClient, tokenManager }),
        createCreateTagTool({ client: openproviderClient, tokenManager }),
        createDeleteTagTool({ client: openproviderClient, tokenManager }),
        createListSslProductsTool({ client: openproviderClient, tokenManager }),
        createGetSslProductTool({ client: openproviderClient, tokenManager }),
        createListSslOrdersTool({ client: openproviderClient, tokenManager }),
        createGetSslOrderTool({ client: openproviderClient, tokenManager }),
        createGetSslApproverEmailsTool({ client: openproviderClient, tokenManager }),
        createUpdateSslOrderTool({ client: openproviderClient, tokenManager }),
        createUpdateSslApproverEmailTool({ client: openproviderClient, tokenManager }),
        createResendSslApproverEmailTool({ client: openproviderClient, tokenManager }),
        createCreateCsrTool({ client: openproviderClient, tokenManager }),
        createDecodeCsrTool({ client: openproviderClient, tokenManager }),
        createCreateSslOtpTokenTool({ client: openproviderClient, tokenManager }),
        createCreateSslOrderTool({ client: openproviderClient, tokenManager }),
        createRenewSslOrderTool({ client: openproviderClient, tokenManager }),
        createReissueSslOrderTool({ client: openproviderClient, tokenManager }),
        createCancelSslOrderTool({ client: openproviderClient, tokenManager }),
        createListCustomersTool({ client: openproviderClient, tokenManager }),
        createGetCustomerTool({ client: openproviderClient, tokenManager }),
        createCreateCustomerTool({ client: openproviderClient, tokenManager }),
        createUpdateCustomerTool({ client: openproviderClient, tokenManager }),
        createDeleteCustomerTool({ client: openproviderClient, tokenManager }),
        createListEmailTemplatesTool({ client: openproviderClient, tokenManager }),
        createCreateEmailTemplateTool({ client: openproviderClient, tokenManager }),
        createUpdateEmailTemplateTool({ client: openproviderClient, tokenManager }),
        createDeleteEmailTemplateTool({ client: openproviderClient, tokenManager }),
        createListEmailVerificationDomainsTool({ client: openproviderClient, tokenManager }),
        createStartEmailVerificationTool({ client: openproviderClient, tokenManager }),
        createRestartEmailVerificationTool({ client: openproviderClient, tokenManager }),
        createGetDmarcTool({ client: openproviderClient, tokenManager }),
        createListDmarcSubscriptionsTool({ client: openproviderClient, tokenManager }),
        createCreateDmarcTool({ client: openproviderClient, tokenManager }),
        createRetryDmarcTool({ client: openproviderClient, tokenManager }),
        createDmarcSsoLoginTool({ client: openproviderClient, tokenManager }),
        createDeleteDmarcTool({ client: openproviderClient, tokenManager }),
        createGetSpamExpertsDomainTool({ client: openproviderClient, tokenManager }),
        createSpamExpertsLoginUrlTool({ client: openproviderClient, tokenManager }),
        createCreateSpamExpertsDomainTool({ client: openproviderClient, tokenManager }),
        createUpdateSpamExpertsDomainTool({ client: openproviderClient, tokenManager }),
        createDeleteSpamExpertsDomainTool({ client: openproviderClient, tokenManager }),
        createListLicensePricesTool({ client: openproviderClient, tokenManager }),
        createListLicenseItemsTool({ client: openproviderClient, tokenManager }),
        createListPleskLicensesTool({ client: openproviderClient, tokenManager }),
        createGetPleskLicenseTool({ client: openproviderClient, tokenManager }),
        createGetPleskKeyTool({ client: openproviderClient, tokenManager }),
        createCreatePleskLicenseTool({ client: openproviderClient, tokenManager }),
        createUpdatePleskLicenseTool({ client: openproviderClient, tokenManager }),
        createResetPleskHwidTool({ client: openproviderClient, tokenManager }),
        createDeletePleskLicenseTool({ client: openproviderClient, tokenManager }),
      ];

      // Path 2: confirm_pending's consume — validates AND executes the original tool.
      // Uses the shared createConfirmPendingConsume factory (src/mcp/confirm-pending.ts)
      // so the dashboard approve handler can call the same logic without duplication.
      const confirmPendingConsume = createConfirmPendingConsume({
        tools,
        validateConfirmation,
        claimConfirmation: (_c, id) => claimConfirmation(client, id),
        unclaimConfirmation: (_c, id) => unclaimConfirmation(client, id),
        settleConfirmation: (_c, id, outcome) => settleConfirmation(client, id, outcome),
        client,
      });

      // Push confirm_pending after tools is already populated (closure is safe).
      tools.push(createConfirmPendingTool({ consume: confirmPendingConsume }));

      const dispatch = createDispatcher({
        tools,
        audit: createPgAuditSink(client),
        confirm,
      });

      return {
        dispatch,
        cleanup: async () => {
          try {
            if (inTx) await client.query('COMMIT');
          } catch {
            try {
              await client.query('ROLLBACK');
            } catch {
              /* ignore */
            }
          } finally {
            client.release();
          }
        },
      };
    } catch (err) {
      try {
        if (inTx) await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      client.release();
      throw err;
    }
  }

  const apiKeyResolver = createApiKeyResolver(pool);

  const app = await createMcpServer({
    devToken: cfg.devBearerToken,
    devPrincipal,
    trustProxy: cfg.trustProxy,
    apiKeyResolver,
    tools: buildToolCatalog(),
    dispatchFactory,
    readinessChecks: [
      {
        name: 'db',
        check: async () => {
          const c = await pool.connect();
          try {
            await c.query('SELECT 1');
            return true;
          } finally {
            c.release();
          }
        },
      },
      {
        name: 'kms',
        check: async () => {
          await kms.generateDataKey(cfg.gcpKmsKeyName);
          return true;
        },
      },
    ],
  });

  // ---------------------------------------------------------------------------
  // Dashboard — mounts on the same Fastify app, before listen so plugins
  // (cookie, view, static) are registered before the server starts accepting
  // connections. createMcpServer does NOT call app.ready() internally, so
  // plugin registration here is safe.
  // ---------------------------------------------------------------------------
  await registerDashboard(app, {
    cookieSecret: cfg.dashboardCookieSecret,
    cookieSecure: cfg.cookieSecure,
    signup: async (email, password) => {
      try {
        assertPasswordPolicy(password);
      } catch {
        return { status: 'invalid_password' as const };
      }
      const r = await signupFn(pool, email, await hashPassword(password));
      return r.status === 'created'
        ? {
            status: 'created' as const,
            tenantId: r.tenantId,
            userId: r.userId,
            role: r.role,
            email,
          }
        : { status: 'email_taken' as const };
    },
    login: async (email, password) => {
      const u = await findUserByEmail(pool, email);
      if (!u || !u.passwordHash || !(await verifyPassword(u.passwordHash, password)))
        return { ok: false as const };
      return { ok: true as const, tenantId: u.tenantId, userId: u.userId, role: u.role, email };
    },
    registerPages: (pageApp) => {
      registerOverview(pageApp, { pool });
      registerOpenprovider(pageApp, { pool, kms, kmsKeyName: cfg.gcpKmsKeyName });
      registerPolicy(pageApp, { pool });
      registerKeys(pageApp, { pool });
      registerAudit(pageApp, { pool });
      registerConfirmations(pageApp, {
        pool,
        kms,
        kmsKeyName: cfg.gcpKmsKeyName,
        openproviderClient,
      });
      registerUsers(pageApp, { pool });
      registerAccept(pageApp, { pool });
      registerAuthRoutes(pageApp, { pool });
    },
  });

  const shutdown = async (): Promise<void> => {
    logger.info({ event: 'shutdown' }, 'shutting down');
    await app.close();
    await pool.end();
    await otel.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  await app.listen({ host: '0.0.0.0', port: cfg.port });
  logger.info({ event: 'startup', port: cfg.port }, 'mcp server listening');
}

main().catch((err: unknown) => {
  // Last-resort logger; full one may not have started.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

/**
 * Dashboard route: /dashboard/confirmations
 *
 * Lists pending confirmations for the tenant and allows the owner to
 * approve them. Approval drives the same validate→claim→execute→settle
 * path as the MCP confirm_pending tool via an injected consumeFactory.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Kms } from '../../secrets/kms.js';
import type { OpenproviderClient } from '../../openprovider/client.js';
import { requireSession, requireRole, assertCsrf } from '../session.js';
import type { DashboardSession } from '../session.js';
import { withTenantConn } from '../with-tenant-conn.js';
import type { Principal } from '../../auth/principal.js';
import type { ConfirmPendingConsumeFn } from '../../mcp/confirm-pending.js';
import { createConfirmPendingConsume } from '../../mcp/confirm-pending.js';
import { loadConfirmation, settleConfirmation, canonicalArgsHash } from '../../policies/repo.js';
import { claimConfirmation, unclaimConfirmation } from '../../policies/idempotency.js';
import { createPricing, DRIFT_TOLERANCE } from '../../policies/pricing.js';
import { createOpenproviderTokenManager } from '../../openprovider/token-manager.js';
import { createPgTokenCache } from '../../openprovider/token-cache-pg.js';
import { createSecretsStore } from '../../secrets/store.js';
import { createDbSecretsRepo } from '../../secrets/db-repo.js';
import { OpenproviderAccountNotConnected } from '../../openprovider/errors.js';
import type { LoadedConfirmation } from '../../policies/repo.js';
import type { Role } from '../../policies/schema.js';
import { createCheckDomainTool } from '../../tools/check-domain.js';
import { createListDomainsTool } from '../../tools/list-domains.js';
import { createGetDomainTool } from '../../tools/get-domain.js';
import { createListContactsTool } from '../../tools/list-contacts.js';
import { createGetContactTool } from '../../tools/get-contact.js';
import { createRegisterDomainTool } from '../../tools/register-domain.js';
import { createUpdateDomainTool } from '../../tools/update-domain.js';
import { createCreateContactTool } from '../../tools/create-contact.js';
import { createUpdateContactTool } from '../../tools/update-contact.js';
import { createDeleteContactTool } from '../../tools/delete-contact.js';
import { createListPendingConfirmationsTool } from '../../tools/list-pending-confirmations.js';

interface PendingConfirmationRow {
  id: string;
  tool_name: string;
  summary_text: string;
  estimated_cost_eur: string;
  required_approver_roles: string[];
  expires_at: Date;
  principal_subject: string;
}

export interface ConfirmationsDeps {
  pool: pg.Pool;
  kms: Kms;
  kmsKeyName: string;
  openproviderClient: OpenproviderClient;
}

/**
 * Build the validate+consume function for a given already-open RLS-scoped client.
 * This mirrors the confirmPendingConsume closure in dispatchFactory — single source
 * of truth is src/mcp/confirm-pending.ts; we just wire the same deps here.
 */
function buildConsumeFn(client: pg.PoolClient, deps: ConfirmationsDeps): ConfirmPendingConsumeFn {
  const pricing = createPricing({ client: deps.openproviderClient });

  const fetchCredentials = async (tid: string): Promise<{ username: string; password: string }> => {
    const u = await client.query<{ username: string }>(
      'SELECT username FROM openprovider_accounts WHERE tenant_id = $1',
      [tid],
    );
    const username = u.rows[0]?.username;
    if (!username) throw new OpenproviderAccountNotConnected();
    const store = createSecretsStore({
      kms: deps.kms,
      kmsKeyArn: deps.kmsKeyName,
      repo: createDbSecretsRepo(client),
    });
    const passwordBuf = await store.get(tid, 'openprovider.password');
    if (!passwordBuf) throw new OpenproviderAccountNotConnected();
    return { username, password: passwordBuf.toString('utf8') };
  };

  const tokenManager = createOpenproviderTokenManager({
    fetchCredentials,
    cache: createPgTokenCache({
      client,
      getDek: async (tid: string) => {
        const r = await client.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
          'SELECT wrapped_dek, kms_key_arn FROM tenant_keys WHERE tenant_id = $1',
          [tid],
        );
        if (!r.rows[0]) throw new Error(`no tenant_keys row for ${tid}`);
        return deps.kms.decrypt(r.rows[0].kms_key_arn, r.rows[0].wrapped_dek);
      },
    }),
  });

  const safeToken = async (tid: string): Promise<string> => {
    try {
      return await tokenManager.getToken(tid);
    } catch (err) {
      if (err instanceof OpenproviderAccountNotConnected) return '';
      throw err;
    }
  };

  const DRIFT_TOL = DRIFT_TOLERANCE;

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
    const freshToken = await safeToken(p.tenantId);
    const fresh = await pricing.price(conf.toolName, args, freshToken);
    if (fresh > Math.round(conf.estimatedCostCents * (1 + DRIFT_TOL))) {
      await settleConfirmation(client, conf.id, 'released');
      return { kind: 'error', code: 'price_changed' };
    }
    return { kind: 'ok', conf };
  };

  // Build same tool set as dispatchFactory (sans confirm_pending itself — no recursion needed).
  const tools = [
    createCheckDomainTool({ client: deps.openproviderClient, tokenManager }),
    createListDomainsTool({ client: deps.openproviderClient, tokenManager }),
    createGetDomainTool({ client: deps.openproviderClient, tokenManager }),
    createListContactsTool({ client: deps.openproviderClient, tokenManager }),
    createGetContactTool({ client: deps.openproviderClient, tokenManager }),
    createRegisterDomainTool({ client: deps.openproviderClient, tokenManager }),
    createUpdateDomainTool({ client: deps.openproviderClient, tokenManager }),
    createCreateContactTool({ client: deps.openproviderClient, tokenManager }),
    createUpdateContactTool({ client: deps.openproviderClient, tokenManager }),
    createDeleteContactTool({ client: deps.openproviderClient, tokenManager }),
    createListPendingConfirmationsTool({ getClient: () => client }),
  ];

  return createConfirmPendingConsume({
    tools,
    validateConfirmation,
    claimConfirmation: (_c, id) => claimConfirmation(client, id),
    unclaimConfirmation: (_c, id) => unclaimConfirmation(client, id),
    settleConfirmation: (_c, id, outcome) => settleConfirmation(client, id, outcome),
    client,
  });
}

export function registerConfirmations(app: FastifyInstance, deps: ConfirmationsDeps): void {
  // GET /dashboard/confirmations — list pending (unconsumed, unexpired)
  app.get('/dashboard/confirmations', { preHandler: requireSession }, async (req, reply) => {
    const session = (req as typeof req & { session: DashboardSession }).session;

    const pending = await withTenantConn(deps.pool, session.tenantId, async (client) => {
      const r = await client.query<PendingConfirmationRow>(
        `SELECT id, tool_name, summary_text, estimated_cost_eur,
                required_approver_roles, expires_at, principal_subject
           FROM confirmations
          WHERE tenant_id = $1
            AND consumed_at IS NULL
            AND expires_at > now()
          ORDER BY expires_at ASC`,
        [session.tenantId],
      );
      return r.rows;
    });

    return reply.view('confirmations', {
      csrf: session.csrf,
      pending,
      approveResult: null,
    });
  });

  // POST /dashboard/confirmations/:id/approve — run same consume path as confirm_pending
  app.post(
    '/dashboard/confirmations/:id/approve',
    { preHandler: requireRole('owner', 'admin') },
    async (req, reply) => {
      if (!assertCsrf(req)) {
        return reply.code(403).send('Forbidden: CSRF token mismatch');
      }

      const session = (req as typeof req & { session: DashboardSession }).session;
      const { id } = req.params as { id: string };

      // Build a principal from the session. The approver's real role drives the
      // requiredApproverRoles check in the consume path (operator/viewer can't reach
      // this route; an admin must not approve an owner-only confirmation).
      const principal: Principal = {
        kind: 'user',
        tenantId: session.tenantId,
        userId: session.userId,
        subject: session.subject,
        scopes: ['mcp:read', 'mcp:write'],
        role: session.role,
      };

      let approveResult: { kind: 'ok' | 'error'; message: string };

      await withTenantConn(deps.pool, session.tenantId, async (client) => {
        // Load the confirmation to get its stored args for the consume call
        const conf = await loadConfirmation(client, id);
        if (!conf) {
          approveResult = { kind: 'error', message: 'Confirmation not found or already consumed.' };
          return;
        }
        if (conf.consumedAt || conf.expiresAt.getTime() <= Date.now()) {
          approveResult = { kind: 'error', message: 'Confirmation expired or already consumed.' };
          return;
        }

        const consumeFn = buildConsumeFn(client, deps);
        const result = await consumeFn({
          confirmationId: id,
          args: conf.argsJsonb,
          principal,
        });

        if (result.kind === 'ok') {
          approveResult = { kind: 'ok', message: 'Confirmation approved and executed.' };
        } else {
          approveResult = { kind: 'error', message: `Approval failed: ${result.code}` };
        }
      });

      // Re-fetch pending list to re-render
      const pending = await withTenantConn(deps.pool, session.tenantId, async (client) => {
        const r = await client.query<PendingConfirmationRow>(
          `SELECT id, tool_name, summary_text, estimated_cost_eur,
                  required_approver_roles, expires_at, principal_subject
             FROM confirmations
            WHERE tenant_id = $1
              AND consumed_at IS NULL
              AND expires_at > now()
            ORDER BY expires_at ASC`,
          [session.tenantId],
        );
        return r.rows;
      });

      return reply.view('confirmations', {
        csrf: session.csrf,
        pending,
        approveResult: approveResult!,
      });
    },
  );
}

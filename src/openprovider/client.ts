import CircuitBreaker from 'opossum';
import {
  OpenproviderAuthError,
  OpenproviderRateLimitError,
  OpenproviderUnavailableError,
  OpenproviderClientError,
} from './errors.js';
import {
  CheckDomainArgs,
  CheckDomainResult,
  ListDomainsArgs,
  ListContactsArgs,
  RegisterDomainArgs,
  UpdateDomainArgs,
  CreateContactArgs,
  UpdateContactArgs,
  SuggestDomainArgs,
  ResetAuthcodeArgs,
  ApproveTransferArgs,
  RenewDomainArgs,
  TransferDomainArgs,
  TradeDomainArgs,
  RestoreDomainArgs,
  RestartDomainOperationArgs,
} from './types.js';

export interface OpenproviderClientConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  breakerOptions?: {
    timeout?: number;
    errorThresholdPercentage?: number;
    volumeThreshold?: number;
    resetTimeout?: number;
  };
}

export interface OpenproviderClient {
  checkDomain(token: string, args: CheckDomainArgs): Promise<CheckDomainResult>;
  listDomains(token: string, args: ListDomainsArgs): Promise<unknown>;
  getDomain(token: string, id: number): Promise<unknown>;
  listContacts(token: string, args: ListContactsArgs): Promise<unknown>;
  getContact(token: string, id: number): Promise<unknown>;
  registerDomain(
    token: string,
    args: RegisterDomainArgs,
    idempotencyKey?: string,
  ): Promise<unknown>;
  updateDomain(
    token: string,
    id: number,
    args: UpdateDomainArgs,
    idempotencyKey?: string,
  ): Promise<unknown>;
  createContact(token: string, args: CreateContactArgs, idempotencyKey?: string): Promise<unknown>;
  updateContact(
    token: string,
    id: number,
    args: UpdateContactArgs,
    idempotencyKey?: string,
  ): Promise<unknown>;
  deleteContact(token: string, id: number, idempotencyKey?: string): Promise<unknown>;
  suggestDomain(token: string, args: SuggestDomainArgs): Promise<unknown>;
  getDomainAuthcode(token: string, id: number): Promise<unknown>;
  resetDomainAuthcode(token: string, args: ResetAuthcodeArgs): Promise<unknown>;
  approveDomainTransfer(token: string, args: ApproveTransferArgs): Promise<unknown>;
  sendFoa1DomainTransfer(token: string, id: number): Promise<unknown>;
  deleteDomain(token: string, id: number): Promise<unknown>;
  restartDomainOperation(token: string, args: RestartDomainOperationArgs): Promise<unknown>;
  renewDomain(token: string, args: RenewDomainArgs): Promise<unknown>;
  transferDomain(token: string, args: TransferDomainArgs): Promise<unknown>;
  tradeDomain(token: string, args: TradeDomainArgs): Promise<unknown>;
  restoreDomain(token: string, args: RestoreDomainArgs): Promise<unknown>;
}

const DEFAULT_BASE = 'https://api.openprovider.eu/v1beta';

export function createOpenproviderClient(
  config: OpenproviderClientConfig = {},
): OpenproviderClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE;
  const fetcher = config.fetchImpl ?? fetch;

  async function request(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const attempt = async (n: number): Promise<unknown> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const res = await fetcher(`${baseUrl}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'user-agent': 'openprovider-mcp/0.2.0-phase2',
            ...(extraHeaders ?? {}),
          },
          body: body === undefined ? null : JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (res.status >= 500) {
          if (n < 3) {
            const backoff = [250, 1000, 4000][n] ?? 4000;
            await new Promise((r) => setTimeout(r, backoff));
            return attempt(n + 1);
          }
          throw new OpenproviderUnavailableError(`upstream ${res.status}`);
        }
        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          if (n < 2) {
            const wait = retryAfter ? Number(retryAfter) * 1000 : 1000;
            await new Promise((r) => setTimeout(r, wait));
            return attempt(n + 1);
          }
          throw new OpenproviderRateLimitError('upstream 429');
        }
        if (res.status === 401) throw new OpenproviderAuthError('upstream 401');
        if (res.status >= 400) {
          const text = await res.text();
          throw new OpenproviderClientError(
            `upstream ${res.status}: ${text.slice(0, 200)}`,
            res.status,
          );
        }
        return (await res.json()) as unknown;
      } finally {
        clearTimeout(timer);
      }
    };
    return attempt(0);
  }

  function toQuery(params: Record<string, unknown>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  const checkDomainBreaker = new CircuitBreaker(
    async (token: string, args: CheckDomainArgs) => request('POST', '/domains/check', token, args),
    {
      timeout: config.breakerOptions?.timeout ?? 65_000,
      errorThresholdPercentage: config.breakerOptions?.errorThresholdPercentage ?? 50,
      volumeThreshold: config.breakerOptions?.volumeThreshold ?? 20,
      resetTimeout: config.breakerOptions?.resetTimeout ?? 30_000,
    },
  );
  return {
    async listDomains(token, args) {
      const a = ListDomainsArgs.parse(args);
      const body = await request('GET', `/domains${toQuery(a)}`, token);
      return (body as { data?: unknown }).data ?? body;
    },
    async getDomain(token, id) {
      const body = await request('GET', `/domains/${id}`, token);
      return (body as { data?: unknown }).data ?? body;
    },
    async listContacts(token, args) {
      const a = ListContactsArgs.parse(args);
      const body = await request('GET', `/contacts${toQuery(a)}`, token);
      return (body as { data?: unknown }).data ?? body;
    },
    async getContact(token, id) {
      const body = await request('GET', `/contacts/${id}`, token);
      return (body as { data?: unknown }).data ?? body;
    },
    async registerDomain(token, args, idempotencyKey) {
      const parsed = RegisterDomainArgs.parse(args);
      const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
      const body = await request('POST', '/domains', token, parsed, headers);
      return (body as { data?: unknown }).data ?? body;
    },
    async updateDomain(token, id, args, idempotencyKey) {
      const parsed = UpdateDomainArgs.parse(args);
      const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
      // `id` is in the path; send only the remaining fields as body.
      const bodyArgs = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'id'));
      const body = await request('PUT', `/domains/${id}`, token, bodyArgs, headers);
      return (body as { data?: unknown }).data ?? body;
    },
    async createContact(token, args, idempotencyKey) {
      const parsed = CreateContactArgs.parse(args);
      const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
      const body = await request('POST', '/contacts', token, parsed, headers);
      return (body as { data?: unknown }).data ?? body;
    },
    async updateContact(token, id, args, idempotencyKey) {
      const parsed = UpdateContactArgs.parse(args);
      const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
      // `id` is in the path; send only the remaining fields as body.
      const bodyArgs = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'id'));
      const body = await request('PUT', `/contacts/${id}`, token, bodyArgs, headers);
      return (body as { data?: unknown }).data ?? body;
    },
    async deleteContact(token, id, idempotencyKey) {
      const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined;
      const body = await request('DELETE', `/contacts/${id}`, token, undefined, headers);
      return (body as { data?: unknown }).data ?? body;
    },
    async suggestDomain(token, args) {
      const parsed = SuggestDomainArgs.parse(args);
      const body = await request('POST', '/domains/suggest-name', token, parsed);
      return (body as { data?: unknown }).data ?? body;
    },
    async getDomainAuthcode(token, id) {
      const body = await request('GET', `/domains/${id}/authcode`, token);
      return (body as { data?: unknown }).data ?? body;
    },
    async resetDomainAuthcode(token, args) {
      const parsed = ResetAuthcodeArgs.parse(args);
      const body = await request('POST', `/domains/${parsed.id}/authcode/reset`, token, parsed);
      return (body as { data?: unknown }).data ?? body;
    },
    async approveDomainTransfer(token, args) {
      const parsed = ApproveTransferArgs.parse(args);
      const body = await request('POST', `/domains/${parsed.id}/transfer/approve`, token, parsed);
      return (body as { data?: unknown }).data ?? body;
    },
    async sendFoa1DomainTransfer(token, id) {
      const body = await request('POST', `/domains/${id}/transfer/send-foa1`, token, { id });
      return (body as { data?: unknown }).data ?? body;
    },
    async deleteDomain(token, id) {
      const body = await request('DELETE', `/domains/${id}`, token);
      return (body as { data?: unknown }).data ?? body;
    },
    async restartDomainOperation(token, args) {
      const parsed = RestartDomainOperationArgs.parse(args);
      const body = await request(
        'POST',
        `/domains/${parsed.id}/last-operation/restart`,
        token,
        parsed,
      );
      return (body as { data?: unknown }).data ?? body;
    },
    async renewDomain(token, args) {
      const parsed = RenewDomainArgs.parse(args);
      const body = await request('POST', `/domains/${parsed.id}/renew`, token, parsed);
      return (body as { data?: unknown }).data ?? body;
    },
    async transferDomain(token, args) {
      const parsed = TransferDomainArgs.parse(args);
      const body = await request('POST', '/domains/transfer', token, parsed);
      return (body as { data?: unknown }).data ?? body;
    },
    async tradeDomain(token, args) {
      const parsed = TradeDomainArgs.parse(args);
      const body = await request('POST', '/domains/trade', token, parsed);
      return (body as { data?: unknown }).data ?? body;
    },
    async restoreDomain(token, args) {
      const parsed = RestoreDomainArgs.parse(args);
      const body = await request('POST', `/domains/${parsed.id}/restore`, token, parsed);
      return (body as { data?: unknown }).data ?? body;
    },
    async checkDomain(token, args) {
      const parsedArgs = CheckDomainArgs.parse(args);
      let body: unknown;
      try {
        body = await checkDomainBreaker.fire(token, parsedArgs);
      } catch (err) {
        // Pass through known domain errors directly.
        if (err instanceof OpenproviderAuthError) throw err;
        if (err instanceof OpenproviderUnavailableError) throw err;
        if (err instanceof OpenproviderRateLimitError) throw err;
        if (err instanceof OpenproviderClientError) throw err;
        // opossum open-circuit error (EOPENBREAKER) → translate to unavailable.
        if (
          err instanceof Error &&
          ((err as Error & { code?: string }).code === 'EOPENBREAKER' ||
            err.message.includes('Breaker is open') ||
            err.message.includes('circuit'))
        ) {
          throw new OpenproviderUnavailableError('circuit open');
        }
        throw err;
      }
      const data = (body as { data?: unknown }).data ?? body;
      return CheckDomainResult.parse(data);
    },
  };
}

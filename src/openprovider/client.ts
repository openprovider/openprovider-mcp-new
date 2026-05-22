import CircuitBreaker from 'opossum';
import {
  OpenproviderAuthError,
  OpenproviderRateLimitError,
  OpenproviderUnavailableError,
  OpenproviderClientError,
} from './errors.js';
import { CheckDomainArgs, CheckDomainResult } from './types.js';

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

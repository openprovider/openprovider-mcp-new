import { OpenproviderAuthError } from './errors.js';

export interface TokenCache {
  get(tenantId: string): Promise<{ token: string; expiresAt: Date } | null>;
  set(tenantId: string, value: { token: string; expiresAt: Date }): void | Promise<void>;
  clear(tenantId: string): void | Promise<void>;
}

export interface TokenManagerConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  fetchCredentials: (tenantId: string) => Promise<{ username: string; password: string }>;
  cache: TokenCache;
  defaultTtlMs?: number;
}

export interface OpenproviderTokenManager {
  getToken(tenantId: string): Promise<string>;
  invalidate(tenantId: string): Promise<void>;
}

const DEFAULT_BASE = 'https://api.openprovider.eu/v1beta';
const DEFAULT_TTL = 12 * 60 * 60 * 1000; // 12h, conservative

export function createOpenproviderTokenManager(
  config: TokenManagerConfig,
): OpenproviderTokenManager {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE;
  const fetcher = config.fetchImpl ?? fetch;
  const inflight = new Map<string, Promise<string>>();

  async function login(tenantId: string): Promise<string> {
    const creds = await config.fetchCredentials(tenantId);
    const res = await fetcher(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    });
    if (res.status === 401) throw new OpenproviderAuthError('invalid Openprovider credentials');
    const body = (await res.json().catch(() => ({}))) as {
      code?: number;
      data?: { token?: string };
    };
    // Openprovider reports bad credentials as code 196, sometimes with a non-401 status
    // (observed HTTP 500) or even a 200 envelope. Map it explicitly.
    if (body.code === 196) {
      throw new OpenproviderAuthError('invalid Openprovider credentials');
    }
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    const token = body.data?.token;
    if (!token) throw new Error('login response missing data.token');
    const expiresAt = new Date(Date.now() + (config.defaultTtlMs ?? DEFAULT_TTL));
    await config.cache.set(tenantId, { token, expiresAt });
    return token;
  }

  return {
    async getToken(tenantId) {
      const cached = await config.cache.get(tenantId);
      if (cached && cached.expiresAt.getTime() > Date.now()) return cached.token;
      const existing = inflight.get(tenantId);
      if (existing) return existing;
      const p = login(tenantId).finally(() => inflight.delete(tenantId));
      inflight.set(tenantId, p);
      return p;
    },
    async invalidate(tenantId) {
      await config.cache.clear(tenantId);
    },
  };
}

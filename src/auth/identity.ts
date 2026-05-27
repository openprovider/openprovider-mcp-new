import type { Principal } from './principal.js';
import type { ApiKeyResolver } from './api-key.js';

export interface IdentityResolverConfig {
  devToken: string;
  devPrincipal: Principal;
  apiKeyResolver?: ApiKeyResolver;
}

export type IdentityResolver = (
  authorizationHeader: string | undefined,
) => Promise<Principal | null>;

export function createIdentityResolver(config: IdentityResolverConfig): IdentityResolver {
  return async (header) => {
    if (!header) return null;
    const parts = header.split(' ');
    const scheme = parts[0];
    const token = parts[1];
    if (scheme !== 'Bearer' || !token) return null;
    if (token === config.devToken) return config.devPrincipal;
    if (token.startsWith('op_live_')) {
      if (!config.apiKeyResolver) return null;
      return config.apiKeyResolver(token);
    }
    return null;
  };
}

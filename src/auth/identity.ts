import type { Principal } from './principal.js';

export interface IdentityResolverConfig {
  devToken: string;
  devPrincipal: Principal;
}

export type IdentityResolver = (
  authorizationHeader: string | undefined,
) => Promise<Principal | null>;

export function createIdentityResolver(config: IdentityResolverConfig): IdentityResolver {
  return (header) => {
    if (!header) return Promise.resolve(null);
    const parts = header.split(' ');
    const scheme = parts[0];
    const token = parts[1];
    if (scheme !== 'Bearer' || !token) return Promise.resolve(null);
    if (token === config.devToken) return Promise.resolve(config.devPrincipal);
    if (token.startsWith('op_live_')) {
      return Promise.reject(new Error('API key authentication lands in phase 6'));
    }
    // WorkOS OAuth introspection lands in phase 2.
    return Promise.resolve(null);
  };
}

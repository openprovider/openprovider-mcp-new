import type { Principal } from './principal.js';
import type { AccessTokenVerifier } from './oauth/workos.js';

export interface IdentityResolverConfig {
  devToken: string;
  devPrincipal: Principal;
  verifier?: AccessTokenVerifier;
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
      throw new Error('API key authentication lands in phase 6');
    }
    if (config.verifier) {
      try {
        const claims = await config.verifier(token);
        return {
          kind: 'user',
          tenantId: claims.tenantId,
          userId: claims.subject,
          subject: claims.subject,
          scopes: claims.scopes,
          role: claims.scopes.includes('mcp:write') ? 'operator' : 'viewer',
        };
      } catch {
        return null;
      }
    }
    return null;
  };
}

import type { Principal } from './principal.js';
import type { AccessTokenVerifier } from './oauth/workos.js';
import type { TenantResolver } from './tenant-resolver.js';

export interface IdentityResolverConfig {
  devToken: string;
  devPrincipal: Principal;
  verifier?: AccessTokenVerifier;
  resolveTenant?: TenantResolver;
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
    if (config.verifier && config.resolveTenant) {
      let claims;
      try {
        claims = await config.verifier(token);
      } catch {
        return null; // invalid token → 401
      }
      // resolveTenant failure is a server error, not an auth failure — let it throw.
      const resolution = await config.resolveTenant(claims.subject, claims.email);
      return {
        kind: 'user',
        tenantId: resolution.tenantId,
        userId: resolution.userId,
        subject: claims.subject,
        scopes: [],
        role: resolution.role,
      };
    }
    return null;
  };
}

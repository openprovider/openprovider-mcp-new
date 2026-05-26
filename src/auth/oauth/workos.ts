import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';

export class OAuthVerificationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OAuthVerificationError';
  }
}

export interface WorkOsVerifierConfig {
  clientId: string;
  issuer: string;
  jwksUri: string;
}

export interface VerifiedClaims {
  subject: string;
  email: string;
  expiresAt: Date;
}

export type AccessTokenVerifier = (token: string) => Promise<VerifiedClaims>;

export function createWorkOsVerifier(config: WorkOsVerifierConfig): AccessTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
    cacheMaxAge: 60 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  return async (token: string): Promise<VerifiedClaims> => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ['RS256'],
      });
      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      const email = typeof payload['email'] === 'string' ? payload['email'] : '';
      if (!sub) throw new OAuthVerificationError('missing sub claim');
      return {
        subject: sub,
        email,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 60_000),
      };
    } catch (err) {
      if (err instanceof OAuthVerificationError) throw err;
      if (err instanceof joseErrors.JOSEError) {
        throw new OAuthVerificationError(`token verification failed: ${err.code}`, err);
      }
      throw new OAuthVerificationError('token verification failed', err);
    }
  };
}

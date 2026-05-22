import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import nock from 'nock';

export interface FakeJwks {
  issuer: string;
  audience: string;
  jwksUri: string;
  install: () => void;
  mintToken: (claims: Record<string, unknown>, expIn?: string) => Promise<string>;
}

export async function createFakeJwks(
  opts: {
    issuer?: string;
    audience?: string;
    jwksUri?: string;
  } = {},
): Promise<FakeJwks> {
  const issuer = opts.issuer ?? 'https://api.workos.com';
  const audience = opts.audience ?? 'client_test';
  const jwksUri = opts.jwksUri ?? `${issuer}/sso/jwks/${audience}`;

  const kp = await generateKeyPair('RS256');
  const signKey = kp.privateKey;
  const pubJwk = await exportJWK(kp.publicKey);
  (pubJwk as JWK & { kid: string; alg: string }).kid = 'fake-kid-1';
  (pubJwk as JWK & { kid: string; alg: string }).alg = 'RS256';

  return {
    issuer,
    audience,
    jwksUri,
    install: () => {
      const url = new URL(jwksUri);
      // Persist so multiple verifier calls within the test can hit it.
      nock(url.origin)
        .persist()
        .get(url.pathname)
        .reply(200, { keys: [pubJwk] });
    },
    async mintToken(claims, expIn = '5m') {
      return await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'fake-kid-1' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(expIn)
        .sign(signKey);
    },
  };
}

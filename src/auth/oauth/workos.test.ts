import { describe, expect, it, beforeAll } from 'vitest';
import { createWorkOsVerifier, OAuthVerificationError } from './workos.js';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import nock from 'nock';

describe('workos verifier', () => {
  let signKey: CryptoKey;
  let publicJwk: ReturnType<typeof exportJWK> extends Promise<infer T> ? T : never;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    signKey = kp.privateKey;
    const pub = await exportJWK(kp.publicKey);
    pub.kid = 'test-kid';
    pub.alg = 'RS256';
    publicJwk = pub;
  });

  function mockJwks(uri: string) {
    const url = new URL(uri);
    nock(url.origin)
      .get(url.pathname)
      .reply(200, { keys: [publicJwk] });
  }

  async function token(claims: Record<string, unknown>, exp = '5m'): Promise<string> {
    return await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('https://api.workos.com')
      .setAudience('client_test')
      .setExpirationTime(exp)
      .sign(signKey);
  }

  it('verifies a valid token and returns claims', async () => {
    mockJwks('https://api.workos.com/sso/jwks/client_test');
    const verify = createWorkOsVerifier({
      clientId: 'client_test',
      issuer: 'https://api.workos.com',
      jwksUri: 'https://api.workos.com/sso/jwks/client_test',
    });
    const t = await token({ sub: 'user_123', email: 'user@example.com' });
    const claims = await verify(t);
    expect(claims.subject).toBe('user_123');
    expect(claims.email).toBe('user@example.com');
  });

  it('rejects an expired token', async () => {
    mockJwks('https://api.workos.com/sso/jwks/client_test');
    const verify = createWorkOsVerifier({
      clientId: 'client_test',
      issuer: 'https://api.workos.com',
      jwksUri: 'https://api.workos.com/sso/jwks/client_test',
    });
    const t = await new SignJWT({ sub: 'u', scope: 'mcp:read', 'act.tnt': 't' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('https://api.workos.com')
      .setAudience('client_test')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(signKey);
    await expect(verify(t)).rejects.toBeInstanceOf(OAuthVerificationError);
  });

  it('rejects a wrong-audience token', async () => {
    mockJwks('https://api.workos.com/sso/jwks/client_test');
    const verify = createWorkOsVerifier({
      clientId: 'client_test',
      issuer: 'https://api.workos.com',
      jwksUri: 'https://api.workos.com/sso/jwks/client_test',
    });
    const t = await new SignJWT({ sub: 'u', scope: 'mcp:read', 'act.tnt': 't' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('https://api.workos.com')
      .setAudience('client_other')
      .setExpirationTime('5m')
      .sign(signKey);
    await expect(verify(t)).rejects.toBeInstanceOf(OAuthVerificationError);
  });

  it('accepts a token without act.tnt and returns subject + email', async () => {
    mockJwks('https://api.workos.com/sso/jwks/client_test');
    const verify = createWorkOsVerifier({
      clientId: 'client_test',
      issuer: 'https://api.workos.com',
      jwksUri: 'https://api.workos.com/sso/jwks/client_test',
    });
    const t = await token({ sub: 'user_123', email: 'a@example.com' });
    const claims = await verify(t);
    expect(claims.subject).toBe('user_123');
    expect(claims.email).toBe('a@example.com');
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseWorkosEnv = {
  WORKOS_CLIENT_ID: 'client_test',
  WORKOS_API_KEY: 'sk_test_x',
  WORKOS_AUTHKIT_DOMAIN: 'https://test.authkit.app',
  WORKOS_JWKS_URI: 'https://test.authkit.app/oauth2/jwks',
  WORKOS_ISSUER: 'https://test.authkit.app',
};

describe('config', () => {
  it('throws if a required variable is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('returns a typed config when all required vars are present', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      AWS_REGION: 'eu-central-1',
      AWS_KMS_KEY_ARN: 'alias/x',
      DEV_BEARER_TOKEN: 'dev',
      ...baseWorkosEnv,
    });
    expect(cfg.databaseUrl).toBe('postgres://x');
    expect(cfg.devBearerToken).toBe('dev');
  });

  it('uses defaults for optional vars', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      AWS_REGION: 'eu-central-1',
      AWS_KMS_KEY_ARN: 'alias/x',
      DEV_BEARER_TOKEN: 'dev',
      ...baseWorkosEnv,
    });
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe('info');
  });

  it('throws if WORKOS_CLIENT_ID is missing', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        AWS_KMS_KEY_ARN: 'alias/x',
        DEV_BEARER_TOKEN: 'dev',
        WORKOS_API_KEY: 'sk_test_x',
        WORKOS_AUTHKIT_DOMAIN: 'https://test.authkit.app',
        WORKOS_JWKS_URI: 'https://test.authkit.app/oauth2/jwks',
        WORKOS_ISSUER: 'https://test.authkit.app',
      }),
    ).toThrow(/WORKOS_CLIENT_ID/);
  });

  it('throws if WORKOS_ISSUER is missing (no default)', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        AWS_KMS_KEY_ARN: 'alias/x',
        DEV_BEARER_TOKEN: 'dev',
        WORKOS_CLIENT_ID: 'client_test',
        WORKOS_API_KEY: 'sk_test_x',
        WORKOS_AUTHKIT_DOMAIN: 'https://test.authkit.app',
        WORKOS_JWKS_URI: 'https://test.authkit.app/oauth2/jwks',
      }),
    ).toThrow(/WORKOS_ISSUER/);
  });
});

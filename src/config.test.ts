import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://x',
  DEV_BEARER_TOKEN: 'dev',
  GCP_PROJECT_ID: 'my-project',
  GCP_KMS_KEY_NAME: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
  GCS_BUCKET: 'my-audit-bucket',
  DASHBOARD_COOKIE_SECRET: 'test-cookie-secret-min-length-ok',
};

describe('config', () => {
  it('throws if a required variable is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('returns a typed config when all required vars are present', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', ...baseEnv });
    expect(cfg.databaseUrl).toBe('postgres://x');
    expect(cfg.devBearerToken).toBe('dev');
    expect(cfg.gcpProjectId).toBe('my-project');
    expect(cfg.gcpKmsKeyName).toBe('projects/p/locations/l/keyRings/r/cryptoKeys/k');
    expect(cfg.gcsBucket).toBe('my-audit-bucket');
  });

  it('uses defaults for optional vars', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', ...baseEnv });
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe('info');
  });

  it('throws if GCP_KMS_KEY_NAME is missing', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        DEV_BEARER_TOKEN: 'dev',
        GCP_PROJECT_ID: 'my-project',
        GCS_BUCKET: 'my-bucket',
        DASHBOARD_COOKIE_SECRET: 'test-cookie-secret-min-length-ok',
      }),
    ).toThrow(/GCP_KMS_KEY_NAME/);
  });
});

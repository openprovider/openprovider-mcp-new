import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

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
    });
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe('info');
  });
});

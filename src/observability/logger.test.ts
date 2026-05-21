import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { withRequestContext } from './request-context.js';

describe('logger', () => {
  it('attaches request context to every log line', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: { write: (s: string) => { lines.push(s); return s.length; } },
    });
    withRequestContext({ tenantId: 't-1', principalKind: 'user', principalSubject: 's-1' }, () => {
      logger.info({ event: 'hello' }, 'msg');
    });
    const parsed = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(parsed.tenant_id).toBe('t-1');
    expect(parsed.principal_kind).toBe('user');
    expect(parsed.principal_subject).toBe('s-1');
  });

  it('redacts secret fields', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: { write: (s: string) => { lines.push(s); return s.length; } },
    });
    logger.info({ password: 'p', cookie: 'c', ok: 'ok' }, 'msg');
    const parsed = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.cookie).toBe('[REDACTED]');
    expect(parsed.ok).toBe('ok');
  });
});

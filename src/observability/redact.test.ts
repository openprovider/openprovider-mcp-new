import { describe, expect, it } from 'vitest';
import { redactSensitive, REDACTED, REDACTED_PATHS } from './redact.js';

describe('redactSensitive', () => {
  it('redacts top-level secrets', () => {
    expect(redactSensitive({ password: 'hunter2', other: 'ok' })).toEqual({
      password: REDACTED,
      other: 'ok',
    });
  });

  it('redacts nested keys by path', () => {
    expect(redactSensitive({ data: { token: 'eyJ...' } })).toEqual({
      data: { token: REDACTED },
    });
  });

  it('redacts contact PII by path', () => {
    expect(
      redactSensitive({ contact: { password: 'x', social_security_number: '1', email: 'a@b' } }),
    ).toEqual({ contact: { password: REDACTED, social_security_number: REDACTED, email: 'a@b' } });
  });

  it('passes through ordinary fields untouched', () => {
    expect(redactSensitive({ domain: 'example.com', period: 1 })).toEqual({
      domain: 'example.com',
      period: 1,
    });
  });

  it('redaction list snapshot matches spec', () => {
    expect([...REDACTED_PATHS].sort()).toMatchSnapshot();
  });
});

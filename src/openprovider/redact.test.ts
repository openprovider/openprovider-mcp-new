import { describe, expect, it } from 'vitest';
import { redactContactPii } from './redact.js';

const SENSITIVE_KEYS = [
  'secret_key',
  'username',
  'auth_type',
  'api_access_enabled',
  'api_client_ip_list',
  'password_changed_at',
  'password_change_declined_at',
  'hash_changed_at',
  'last_api_call_at',
  'last_login_at',
  'is_active',
];

function leaky(): Record<string, unknown> {
  return {
    id: 161314,
    handle: 'FG931388-NZ',
    name: { first_name: 'Sarath', last_name: 'A' },
    company_name: '',
    email: 'a@b.c',
    phone: { country_code: '+91', subscriber_number: '5555555555' },
    address: { country: 'IN' },
    role: 'owner',
    locale: 'en',
    reseller_id: 123915,
    // sensitive fields that MUST be stripped:
    secret_key: 'SECRET_PLEASE_REDACT',
    username: 'sarath@x.com',
    auth_type: 'normal',
    api_access_enabled: true,
    api_client_ip_list: { allow: [], deny: [] },
    password_changed_at: '2024-01-01 00:00:00',
    password_change_declined_at: null,
    hash_changed_at: '2024-01-01 00:00:00',
    last_api_call_at: '2026-05-29 12:00:00',
    last_login_at: '2026-05-29 12:00:00',
    is_active: true,
  };
}

describe('redactContactPii', () => {
  it('strips all sensitive fields from a single contact', () => {
    const out = redactContactPii(leaky()) as Record<string, unknown>;
    for (const k of SENSITIVE_KEYS) {
      expect(out, `field "${k}" should be redacted`).not.toHaveProperty(k);
    }
  });

  it('keeps the contact-data fields the model legitimately needs', () => {
    const out = redactContactPii(leaky()) as Record<string, unknown>;
    expect(out.id).toBe(161314);
    expect(out.handle).toBe('FG931388-NZ');
    expect(out.name).toEqual({ first_name: 'Sarath', last_name: 'A' });
    expect(out.email).toBe('a@b.c');
    expect(out.phone).toEqual({ country_code: '+91', subscriber_number: '5555555555' });
    expect(out.address).toEqual({ country: 'IN' });
    expect(out.role).toBe('owner');
    expect(out.locale).toBe('en');
    expect(out.reseller_id).toBe(123915);
  });

  it('redacts every entry in a {results,total} envelope', () => {
    const envelope = { results: [leaky(), leaky()], total: 2 };
    const out = redactContactPii(envelope) as { results: Record<string, unknown>[]; total: number };
    expect(out.total).toBe(2);
    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      for (const k of SENSITIVE_KEYS) {
        expect(r).not.toHaveProperty(k);
      }
      expect(r).toHaveProperty('email');
    }
  });

  it('redacts every entry in a bare array', () => {
    const out = redactContactPii([leaky(), leaky()]) as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r).not.toHaveProperty('secret_key');
      expect(r).toHaveProperty('id');
    }
  });

  it('passes through non-contact payloads unchanged', () => {
    expect(redactContactPii(null)).toBeNull();
    expect(redactContactPii(undefined)).toBeUndefined();
    expect(redactContactPii(42)).toBe(42);
    expect(redactContactPii('hello')).toBe('hello');
    expect(redactContactPii({ unrelated: 'shape', no_id_or_handle: true })).toEqual({
      unrelated: 'shape',
      no_id_or_handle: true,
    });
  });

  it('the secret_key value never appears in the serialized output', () => {
    const out = redactContactPii({ results: [leaky()], total: 1 });
    expect(JSON.stringify(out)).not.toContain('SECRET_PLEASE_REDACT');
  });
});

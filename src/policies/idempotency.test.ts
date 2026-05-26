import { describe, expect, it } from 'vitest';
import { idempotencyKeyFor } from './idempotency.js';

describe('idempotencyKeyFor', () => {
  it('returns the confirmation id when present', () => {
    expect(idempotencyKeyFor('register_domain', { a: 1 }, 't', 'conf-1')).toBe('conf-1');
  });
  it('auto-hashes args order-insensitively when no confirmation id', () => {
    const k1 = idempotencyKeyFor('create_contact', { a: 1, b: 2 }, 't');
    const k2 = idempotencyKeyFor('create_contact', { b: 2, a: 1 }, 't');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('differs by tenant and tool', () => {
    expect(idempotencyKeyFor('create_contact', { a: 1 }, 't1')).not.toBe(
      idempotencyKeyFor('create_contact', { a: 1 }, 't2'),
    );
    expect(idempotencyKeyFor('create_contact', { a: 1 }, 't')).not.toBe(
      idempotencyKeyFor('update_contact', { a: 1 }, 't'),
    );
  });
});

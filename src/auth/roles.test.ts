import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from './roles.js';

describe('roles', () => {
  it('lists exactly the five roles', () => {
    expect([...ROLES].sort()).toEqual(['admin', 'auditor', 'operator', 'owner', 'viewer']);
  });

  it('Role type accepts the four roles (compile-time + runtime membership)', () => {
    const r: Role = 'operator';
    expect(ROLES.has(r)).toBe(true);
  });
});

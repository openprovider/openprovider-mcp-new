import { describe, expect, it } from 'vitest';
import { canManage, canAssignRole, wouldOrphanOwners } from './user-admin.js';

describe('user-admin RBAC helpers', () => {
  it('canManage: owner can manage anyone', () => {
    expect(canManage('owner', 'owner')).toBe(true);
    expect(canManage('owner', 'admin')).toBe(true);
    expect(canManage('owner', 'viewer')).toBe(true);
  });

  it('canManage: admin can manage non-owners but not owners', () => {
    expect(canManage('admin', 'admin')).toBe(true);
    expect(canManage('admin', 'operator')).toBe(true);
    expect(canManage('admin', 'owner')).toBe(false);
  });

  it('canManage: operator/viewer can manage nobody', () => {
    expect(canManage('operator', 'viewer')).toBe(false);
    expect(canManage('viewer', 'viewer')).toBe(false);
  });

  it('canAssignRole: nobody can assign owner (ownership transfer out of scope)', () => {
    expect(canAssignRole('owner', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'owner')).toBe(false);
  });

  it('canAssignRole: owner/admin can assign non-owner roles; operator/viewer cannot', () => {
    expect(canAssignRole('owner', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'viewer')).toBe(true);
    expect(canAssignRole('operator', 'viewer')).toBe(false);
  });

  it('wouldOrphanOwners: removing the only owner orphans', () => {
    expect(wouldOrphanOwners('owner', 1, 'remove')).toBe(true);
    expect(wouldOrphanOwners('owner', 2, 'remove')).toBe(false);
    expect(wouldOrphanOwners('admin', 1, 'remove')).toBe(false);
  });

  it('wouldOrphanOwners: demoting the only owner orphans; demoting one of two does not', () => {
    expect(wouldOrphanOwners('owner', 1, { newRole: 'admin' })).toBe(true);
    expect(wouldOrphanOwners('owner', 2, { newRole: 'admin' })).toBe(false);
    expect(wouldOrphanOwners('owner', 1, { newRole: 'owner' })).toBe(false);
  });
});

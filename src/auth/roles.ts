export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export const ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'operator', 'viewer']);

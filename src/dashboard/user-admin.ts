import type { Role } from '../auth/roles.js';

/** Can an actor with `actorRole` change-role or remove a target with `targetRole`? */
export function canManage(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'owner';
  return false;
}

/** Can an actor assign `newRole`? Owner is never assignable (ownership transfer is out of scope). */
export function canAssignRole(actorRole: Role, newRole: Role): boolean {
  if (newRole === 'owner') return false;
  return actorRole === 'owner' || actorRole === 'admin';
}

/** Would removing / demoting this target leave the tenant with zero owners? */
export function wouldOrphanOwners(
  targetCurrentRole: Role,
  activeOwnerCount: number,
  action: 'remove' | { newRole: Role },
): boolean {
  const losesAnOwner =
    targetCurrentRole === 'owner' && (action === 'remove' || action.newRole !== 'owner');
  return losesAnOwner && activeOwnerCount <= 1;
}
